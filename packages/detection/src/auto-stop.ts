/**
 * Auto-stop rules (task 7.5) as one pure reducer: `autoStop(state, input, now) → { state, actions }`, like
 * `detect` (no timers, no I/O; the host calls again with a `tick` at `nextAutoStopDeadline`).
 *
 * Inputs come from the recording (start/stop, pause, audio levels), from `detect` (`meetingEnded`, whether a
 * call — a D-21 meeting span — is open, and which meeting apps hold the mic right now, eligible or not), the
 * calendar and the user's settings.
 *
 * Rules:
 * 1. Nothing happens in the first `floorMs` (3 min) of a recording.
 * 2. Which ends count (7.2 contract): `meetingEnded` while recording with `recordingStartedDuringMeeting ||
 *    prompted` — the recording is *for* that call (**strict**). More loosely, a call that overlaps the calendar
 *    event the recording's note was made from (notes started from "Upcoming" before joining): that one only
 *    ever asks. Anything else (a FaceTime call during an in-person recording, a voice note) is ignored.
 * 3. An end is only acted on once it has held for `confirmMs` (30 s) — the decision is at
 *    `max(floor, release + confirmMs)`. If one of the call's apps holds the mic again before (or while the
 *    toast is up) — *any* reappearance, eligible or not: muting, a headset switch, a browser audio restart — the
 *    call **resumed**: nothing is shown (or the toast goes away), and the recording remembers the call (rule 4).
 *    Not a resume: the app comes back after the call's event has ended while another attended event is current
 *    — that is the next meeting (back-to-back in the same app), and the first one's end proceeds.
 * 4. A resumed call carries what it was: its strictness and its event pass to the next end of the same apps —
 *    whether detect reports it (`meetingEnded` of the reopened span, whose own flags are false: no prompts while
 *    recording) or the apps simply let go of the mic again (a reappearance detect never re-qualified, e.g. a
 *    browser late in a meeting).
 * 5. A strict end whose calendar event ends within ±`eventEndWindowMs` (5 min) of the release → **stop
 *    automatically**: `stopping` (the "Stopping… Keep recording" toast) and, unless undone, `stop` `undoMs`
 *    (10 s) later — unless the other side is still talking (system audio above `speechDb` after the release):
 *    then ask. Every other counted end → `ask` ("Meeting over? Stop / Keep going"). The event: the one the
 *    prompt named, else the recording's own, else an attended timed event that overlaps the call, the one
 *    ending closest to the release.
 * 6. Silence fallback: both sources below `silenceDb` for `silenceMs` (10 min) of recorded (not paused) time →
 *    `ask`. In-person recordings (no call was part of them) are never stopped automatically — unless the user
 *    turned on `inPerson`, then the silence fallback stops them like rule 5 (toast + undo).
 * 7. With "Stop recording automatically" (`enabled`) off, rule 5 asks instead and `inPerson` is ignored.
 * 8. What is on screen goes away (`cancel`) when: the call resumes (`meeting_resumed`), sound comes back after
 *    a silence notice (`sound`), the user keeps recording (`undo` / `keep`), the recording ends
 *    (`recording_ended`), or the settings change under a pending stop (`settings`). One notice at a time; a
 *    newer one replaces the older (`replaced`). After "Keep going" on a silence notice the silence clock
 *    restarts; after one on a call's end, that end is done.
 */
import { type CalendarEvent, currentMeetingFor, isAttending } from '@oat/core';

import type { DetectionAction } from './detect.ts';

export interface AutoStopConfig {
  /** No decision before the recording is this old. */
  floorMs: number;
  /** A call's end must hold this long (no app coming back) before anything is shown. */
  confirmMs: number;
  /** A calendar event ending this close to the call's end makes the end "clearly over". */
  eventEndWindowMs: number;
  /** Both sources quiet this long → ask. */
  silenceMs: number;
  /** "Quiet" = RMS level (dBFS) of both sources at or below this. */
  silenceDb: number;
  /** System audio above this (dBFS RMS) = someone is talking: a call that "ended" meanwhile is only asked about. */
  speechDb: number;
  /** How long the "Stopping…" toast offers "Keep recording" before the stop. */
  undoMs: number;
}

export const DEFAULT_AUTO_STOP_CONFIG: Readonly<AutoStopConfig> = {
  floorMs: 3 * 60_000,
  confirmMs: 30_000,
  eventEndWindowMs: 5 * 60_000,
  silenceMs: 10 * 60_000,
  silenceDb: -50,
  speechDb: -40,
  undoMs: 10_000,
};

/** System audio that stops being loud within this long after the release is the call's own tail. */
const RELEASE_TAIL_MS = 2_000;

export interface AutoStopSettings {
  /** "Stop recording automatically when the meeting ends" (default on). */
  enabled: boolean;
  /** Also stop in-person recordings (no meeting app) after the silence fallback (default off). */
  inPerson: boolean;
}

export const DEFAULT_AUTO_STOP_SETTINGS: Readonly<AutoStopSettings> = {
  enabled: true,
  inPerson: false,
};

export type AutoStopReason = 'meeting_ended' | 'silence';
export type AutoStopCancelReason =
  'undo' | 'keep' | 'meeting_resumed' | 'sound' | 'recording_ended' | 'settings' | 'replaced';

/** A call's end as auto-stop sees it (pending or on screen). */
export interface CallEnd {
  /** When the app(s) let go of the mic. */
  endedAt: number;
  startedAt: number;
  appIds: readonly string[];
  /** The call's calendar event (resolved when the end came in). */
  eventId: string | null;
  strict: boolean;
}

/** What is on screen: the undo toast (`stopping`) or the question (`ask`). */
export interface AutoStopNotice {
  id: string;
  kind: 'stopping' | 'ask';
  reason: AutoStopReason;
  shownAt: number;
  /** `stopping`: when the stop happens unless undone. */
  stopAt: number | null;
  /** `meeting_ended`: the end it is about (a resume takes it away). */
  end: CallEnd | null;
}

export interface AutoStopRecording {
  since: number;
  /** The calendar event the recording's note was made from (EventKit/Google id, as in `events`). */
  eventId: string | null;
  /** A call (meeting app) was part of this recording: not in-person. */
  call: boolean;
  paused: boolean;
  /** Since when both sources are quiet (recorded time; null = sound now or paused). */
  quietSince: number | null;
  /** System audio is above `speechDb` now. */
  systemTalking: boolean;
  /** Last time system audio was above `speechDb` (it stopped being so, or still is: see `systemTalking`). */
  systemTalkedAt: number | null;
  /** A counted call that resumed (rule 4): what its next end inherits. */
  carry: CallEnd | null;
}

export interface AutoStopState {
  config: AutoStopConfig;
  settings: AutoStopSettings;
  now: number;
  events: readonly CalendarEvent[];
  /** A call (D-21 meeting span) is open right now. */
  callOpen: boolean;
  /** Meeting apps holding the mic right now (detect presences, eligible or not). */
  apps: readonly string[];
  recording: AutoStopRecording | null;
  /** A counted end waiting for its confirmation period / the floor. */
  pendingEnd: CallEnd | null;
  notice: AutoStopNotice | null;
  seq: number;
}

export type MeetingEndedAction = Extract<DetectionAction, { type: 'meetingEnded' }>;

export type AutoStopInput =
  | { type: 'recording'; recording: true; eventId?: string | null; call?: boolean }
  | { type: 'recording'; recording: false }
  | { type: 'paused'; paused: boolean }
  /** Latest RMS levels (dBFS; null = no such source / no level yet = quiet). */
  | { type: 'levels'; mic: number | null; system: number | null }
  | { type: 'meetingEnded'; ended: MeetingEndedAction }
  | { type: 'call'; open: boolean }
  /** The meeting apps holding the mic now (ids; detect presences not gone). */
  | { type: 'apps'; appIds: readonly string[] }
  | { type: 'calendar'; events: readonly CalendarEvent[] }
  | { type: 'settings'; settings: AutoStopSettings }
  /** "Keep recording" (toast) / "Keep going" (question). */
  | { type: 'keep'; id: string }
  /** "Stop recording" on the question: the host stops; this clears it. */
  | { type: 'answered'; id: string }
  | { type: 'tick' };

export type AutoStopAction =
  | { type: 'stopping'; id: string; at: Date; reason: AutoStopReason; stopAt: Date }
  | { type: 'stop'; id: string; at: Date; reason: AutoStopReason }
  | { type: 'ask'; id: string; at: Date; reason: AutoStopReason }
  | { type: 'cancel'; id: string; at: Date; reason: AutoStopCancelReason };

export interface AutoStopResult {
  state: AutoStopState;
  actions: AutoStopAction[];
}

export function initialAutoStopState(
  options: {
    config?: Partial<AutoStopConfig>;
    settings?: Partial<AutoStopSettings>;
    now?: Date;
    events?: readonly CalendarEvent[];
  } = {},
): AutoStopState {
  return {
    config: { ...DEFAULT_AUTO_STOP_CONFIG, ...options.config },
    settings: { ...DEFAULT_AUTO_STOP_SETTINGS, ...options.settings },
    now: options.now?.getTime() ?? Number.NEGATIVE_INFINITY,
    events: options.events ?? [],
    callOpen: false,
    apps: [],
    recording: null,
    pendingEnd: null,
    notice: null,
    seq: 0,
  };
}

/**
 * The calendar event a call belongs to: the one the prompt named, else the recording's own, else an attended,
 * timed event overlapping the call, the one ending closest to `endedAt`.
 */
export function eventForCall(
  events: readonly CalendarEvent[],
  call: { eventId: string | null; startedAt: number; endedAt: number },
  recordingEventId: string | null,
): CalendarEvent | null {
  const byId = (id: string | null) => (id ? (events.find((e) => e.id === id) ?? null) : null);
  const named = byId(call.eventId) ?? byId(recordingEventId);
  if (named) return named;
  let best: CalendarEvent | null = null;
  for (const e of events) {
    if (e.allDay || !isAttending(e)) continue;
    if (e.start.getTime() > call.endedAt || e.end.getTime() < call.startedAt) continue;
    const gap = Math.abs(e.end.getTime() - call.endedAt);
    if (!best || gap < Math.abs(best.end.getTime() - call.endedAt)) best = e;
  }
  return best;
}

const overlaps = (e: CalendarEvent, startedAt: number, endedAt: number) =>
  e.start.getTime() <= endedAt && e.end.getTime() >= startedAt;

const shareApp = (a: readonly string[], b: readonly string[]) => a.some((id) => b.includes(id));

/** When a pending end is decided. */
const decideAt = (end: CallEnd, rec: AutoStopRecording, config: AutoStopConfig) =>
  Math.max(rec.since + config.floorMs, end.endedAt + config.confirmMs);

/** Applies `input` at `now` and every rule that has come due. Pure. */
export function autoStop(state: AutoStopState, input: AutoStopInput, now: Date): AutoStopResult {
  const n = Math.max(now.getTime(), state.now);
  const at = new Date(n);
  const actions: AutoStopAction[] = [];
  let { settings, events, callOpen, apps, recording, pendingEnd, notice, seq } = state;
  const { config } = state;

  const cancel = (reason: AutoStopCancelReason) => {
    if (!notice) return;
    actions.push({ type: 'cancel', id: notice.id, at, reason });
    notice = null;
  };
  const show = (kind: AutoStopNotice['kind'], reason: AutoStopReason, end: CallEnd | null) => {
    cancel('replaced'); // one notice at a time: the newer one wins
    seq += 1;
    const id = `autostop-${seq}`;
    const stopAt = kind === 'stopping' ? n + config.undoMs : null;
    notice = { id, kind, reason, shownAt: n, stopAt, end };
    if (stopAt !== null)
      actions.push({ type: 'stopping', id, at, reason, stopAt: new Date(stopAt) });
    else actions.push({ type: 'ask', id, at, reason });
  };
  const restartSilence = () => {
    if (recording && !recording.paused) recording = { ...recording, quietSince: n };
  };
  /** The call's event has ended and another attended event is current: its app coming back is a new meeting. */
  const nextMeeting = (end: CallEnd) => {
    const event = end.eventId ? events.find((e) => e.id === end.eventId) : null;
    if (!event || event.end.getTime() > n) return false;
    const current = currentMeetingFor(events, at);
    return !!current && current.id !== event.id;
  };
  /** A counted end; `carry` = it continues a resumed call (rule 4). */
  const endCall = (end: CallEnd) => {
    const carry = recording?.carry;
    const inherited =
      carry && shareApp(carry.appIds, end.appIds)
        ? {
            ...end,
            strict: end.strict || carry.strict,
            eventId: end.eventId ?? carry.eventId,
            startedAt: Math.min(end.startedAt, carry.startedAt),
          }
        : end;
    if (!inherited.strict && !looseFor(inherited)) return;
    if (recording && !recording.call) recording = { ...recording, call: true };
    const event = eventForCall(events, inherited, recording?.eventId ?? null);
    pendingEnd = { ...inherited, eventId: event?.id ?? inherited.eventId };
  };
  const looseFor = (end: CallEnd) => {
    const own = recording?.eventId ? events.find((ev) => ev.id === recording!.eventId) : null;
    return !!own && overlaps(own, end.startedAt, end.endedAt);
  };

  switch (input.type) {
    case 'recording':
      if (input.recording) {
        if (recording) break; // already recording (a repeated status)
        cancel('recording_ended');
        pendingEnd = null;
        recording = {
          since: n,
          eventId: input.eventId ?? null,
          call: (input.call ?? false) || callOpen,
          paused: false,
          quietSince: n,
          systemTalking: false,
          systemTalkedAt: null,
          carry: null,
        };
      } else {
        recording = null;
        pendingEnd = null;
        cancel('recording_ended');
      }
      break;
    case 'paused':
      if (!recording || recording.paused === input.paused) break;
      recording = { ...recording, paused: input.paused, quietSince: input.paused ? null : n };
      break;
    case 'levels': {
      if (!recording || recording.paused) break;
      const loud = Math.max(input.mic ?? -Infinity, input.system ?? -Infinity) > config.silenceDb;
      const talking = (input.system ?? -Infinity) > config.speechDb;
      if (talking || recording.systemTalking) {
        recording = { ...recording, systemTalking: talking, systemTalkedAt: n };
      }
      if (loud) {
        recording = { ...recording, quietSince: null };
        if (notice?.reason === 'silence') cancel('sound');
      } else if (recording.quietSince === null) {
        recording = { ...recording, quietSince: n };
      }
      break;
    }
    case 'call':
      callOpen = input.open;
      if (input.open && recording && !recording.call) recording = { ...recording, call: true };
      break;
    case 'apps': {
      const before = apps;
      apps = [...input.appIds];
      if (!recording) break;
      const back = apps.filter((id) => !before.includes(id));
      const shown = notice?.reason === 'meeting_ended' ? notice.end : null;
      // Rule 3: one of the call's apps came back before the end was acted on → resumed (unless rule 3's
      // "next meeting").
      for (const end of [pendingEnd, shown]) {
        if (!end || !shareApp(back, end.appIds) || nextMeeting(end)) continue;
        recording = { ...recording, carry: end };
        if (end === pendingEnd) pendingEnd = null;
        else cancel('meeting_resumed');
      }
      // Rule 4: a resumed call's apps let go again (detect may never report it: never re-qualified).
      const carry = recording.carry;
      if (
        carry &&
        !pendingEnd &&
        !shown &&
        shareApp(before, carry.appIds) &&
        !shareApp(apps, carry.appIds)
      ) {
        endCall({ ...carry, endedAt: n });
      }
      break;
    }
    case 'meetingEnded': {
      const e = input.ended;
      if (!recording || !e.recording) break;
      const end: CallEnd = {
        endedAt: e.endedAt.getTime(),
        startedAt: e.startedAt.getTime(),
        appIds: e.appIds,
        eventId: e.eventId,
        strict: e.recordingStartedDuringMeeting || e.prompted,
      };
      // Already pending from the apps letting go (rule 4): the same end.
      if (pendingEnd && shareApp(pendingEnd.appIds, end.appIds)) {
        end.endedAt = Math.min(end.endedAt, pendingEnd.endedAt);
      }
      endCall(end);
      break;
    }
    case 'calendar':
      events = input.events;
      break;
    case 'settings':
      settings = input.settings;
      if (notice?.kind === 'stopping') cancel('settings');
      break;
    case 'keep':
      if (notice?.id !== input.id) break;
      if (notice.reason === 'silence') restartSilence();
      cancel(notice.kind === 'stopping' ? 'undo' : 'keep');
      break;
    case 'answered':
      if (notice?.id === input.id) notice = null;
      break;
    case 'tick':
      break;
  }

  // Due rules (only while recording, past the floor).
  if (recording && n - recording.since >= config.floorMs) {
    // 5. A counted call end that held.
    if (pendingEnd && n >= decideAt(pendingEnd, recording, config)) {
      const end = pendingEnd;
      pendingEnd = null;
      const event = end.eventId ? events.find((e) => e.id === end.eventId) : null;
      const near =
        !!event && Math.abs(event.end.getTime() - end.endedAt) <= config.eventEndWindowMs;
      const talking =
        recording.systemTalking ||
        (recording.systemTalkedAt !== null &&
          recording.systemTalkedAt > end.endedAt + RELEASE_TAIL_MS);
      const auto = end.strict && near && settings.enabled && !talking;
      show(auto ? 'stopping' : 'ask', 'meeting_ended', end);
    }
    // 6. Silence.
    const quiet = recording.quietSince;
    if (
      !notice &&
      !recording.paused &&
      quiet !== null &&
      n - Math.max(quiet, recording.since) >= config.silenceMs
    ) {
      const auto = !recording.call && settings.enabled && settings.inPerson;
      show(auto ? 'stopping' : 'ask', 'silence', null);
      // Asked once per quiet stretch: the clock restarts (an unanswered question stays on screen).
      recording = { ...recording, quietSince: null };
    }
  }

  // The undo window ran out.
  if (notice?.kind === 'stopping' && notice.stopAt !== null && n >= notice.stopAt) {
    actions.push({ type: 'stop', id: notice.id, at, reason: notice.reason });
    notice = null;
  }

  return {
    state: {
      config,
      settings,
      now: n,
      events,
      callOpen,
      apps,
      recording,
      pendingEnd,
      notice,
      seq,
    },
    actions,
  };
}

/** When `autoStop` must next get a `tick` (epoch ms, after `state.now`), or null. */
export function nextAutoStopDeadline(state: AutoStopState): number | null {
  const { recording, config, notice, now } = state;
  const times: number[] = [];
  if (notice?.stopAt != null) times.push(notice.stopAt);
  if (recording) {
    const floor = recording.since + config.floorMs;
    if (state.pendingEnd) times.push(decideAt(state.pendingEnd, recording, config));
    if (!notice && !recording.paused && recording.quietSince !== null) {
      times.push(
        Math.max(floor, Math.max(recording.quietSince, recording.since) + config.silenceMs),
      );
    }
  }
  const future = times.filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}
