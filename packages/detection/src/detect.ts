/**
 * Meeting detection rules (D-21) as one pure reducer: `detect(state, input, now) → { state, actions }`.
 * No timers, no I/O — the host (`Detector`, or a test's virtual clock) feeds inputs and calls again with a
 * `tick` at `nextDeadline(state)`.
 *
 * Rules:
 * 1. Signal: mic-using processes (sidecar `mic-apps`), resolved to allowlisted meeting apps (`apps.ts`);
 *    several processes of one app fold into one presence.
 * 2. Asymmetric debounce: an app is present as soon as it shows up; it is gone only after it has been absent
 *    for `goneDebounceMs` (2 s). Coming back sooner continues the same presence.
 * 3. Eligibility — a presence looks like a call once, while the app is holding the mic: `promptDelayMs` (2 s)
 *    have passed, the app's `minHoldMs` have passed (15 s for messaging apps: voice notes) unless a calendar
 *    event is current, and — for browsers — a calendar event is current (D-21). Until then it waits; a mic grab
 *    that ends first never counts. Only eligible presences open a *meeting* span and get a prompt.
 * 4. Prompt gates for an eligible presence. Permanent — the presence never prompts: Oat is recording; the app
 *    is silenced; the current event was already prompted for. Temporary — the decision is deferred while the
 *    app keeps the mic: another prompt is on screen; a prompt was shown less than `rateLimitMs` (2 min) ago.
 * 5. Calendar (`currentMeetingFor`: in progress or starting within 90 s, started ≤ 15 min ago) names the
 *    meeting, evaluated when the prompt is actually shown.
 * 6. A prompt is dismissed when its app is gone, recording starts, the app gets silenced, or after
 *    `promptTimeoutMs` (2 min). `promptClosed` (the user acted on it) clears it without an action.
 * 7. `meetingEnded` when the last eligible app is gone (debounced), with the real release time, whether a
 *    prompt was shown, and whether recording *started during* the span. 7.5 auto-stop must only act when
 *    `recording && (recordingStartedDuringMeeting || prompted)`: a recording that was already running (an
 *    in-person meeting) is not ended by an unrelated call or voice note.
 */
import {
  currentMeetingFor,
  CURRENT_MEETING_LEAD_MS,
  isAttending,
  type CalendarEvent,
} from '@oat/core';

import { resolveMeetingApp, type MeetingApp, type MicAppProcessInput } from './apps.ts';

export interface DetectionConfig {
  /** An app absent this long is gone (shorter gaps are absorbed). */
  goneDebounceMs: number;
  /** Delay between an app appearing and its prompt. */
  promptDelayMs: number;
  /** At most one prompt per this long. */
  rateLimitMs: number;
  /** A prompt nobody acted on is dismissed after this long. */
  promptTimeoutMs: number;
}

export const DEFAULT_DETECTION_CONFIG: Readonly<DetectionConfig> = {
  goneDebounceMs: 2_000,
  promptDelayMs: 2_000,
  rateLimitMs: 2 * 60_000,
  promptTimeoutMs: 2 * 60_000,
};

/** One meeting app holding (or recently holding) the mic. Times are epoch ms. */
export interface AppPresence {
  app: MeetingApp;
  /** The app's (first listed) process in the latest snapshot that had it. */
  pid: number;
  bundleId: string | null;
  since: number;
  /** Set while the app is absent but not yet debounced away. */
  goneSince: number | null;
  /** Rule 3 met (sticky for the presence). */
  eligible: boolean;
  /** `pending` until this presence prompted or hit a permanent gate. */
  candidate: 'pending' | 'done';
}

export interface ActivePrompt {
  id: string;
  appId: string;
  eventId: string | null;
  shownAt: number;
}

export interface MeetingSpan {
  /** Earliest `since` of the eligible presences. */
  startedAt: number;
  appIds: readonly string[];
  eventId: string | null;
  prompted: boolean;
  recordingStarted: boolean;
}

export interface DetectionState {
  config: DetectionConfig;
  /** Time of the last input (epoch ms); `nextDeadline` only returns later times. */
  now: number;
  presences: readonly AppPresence[];
  recording: boolean;
  /** When the current recording started (null when not recording or unknown). */
  recordingSince: number | null;
  /** App ids the user said "don't ask for this app" about. */
  silenced: readonly string[];
  events: readonly CalendarEvent[];
  lastPromptAt: number | null;
  /** Events already prompted for (pruned once they end). */
  promptedEventIds: readonly string[];
  prompt: ActivePrompt | null;
  /** From the first eligible app until the last eligible one is gone. */
  meeting: MeetingSpan | null;
  promptSeq: number;
}

export type DetectionInput =
  | { type: 'micApps'; apps: readonly MicAppProcessInput[] }
  | { type: 'recording'; recording: boolean }
  | { type: 'calendar'; events: readonly CalendarEvent[] }
  | { type: 'silenced'; appIds: readonly string[] }
  /** The user acted on the prompt (started notes, closed it): it is gone without a `dismiss`. */
  | { type: 'promptClosed'; promptId: string }
  /** Time passed (called at `nextDeadline`). */
  | { type: 'tick' };

export type DismissReason = 'app_gone' | 'recording' | 'silenced' | 'timeout';

export type DetectionAction =
  | {
      type: 'prompt';
      promptId: string;
      at: Date;
      app: MeetingApp;
      pid: number;
      bundleId: string | null;
      /** The calendar event this is (names the meeting), or null for a generic prompt. */
      event: CalendarEvent | null;
    }
  | { type: 'dismiss'; promptId: string; at: Date; reason: DismissReason }
  | {
      type: 'meetingEnded';
      at: Date;
      startedAt: Date;
      /** When the last eligible app actually released the mic (before the debounce). */
      endedAt: Date;
      appIds: readonly string[];
      /** Oat is recording now. */
      recording: boolean;
      /** A recording started at or after `startedAt` (e.g. from the prompt). */
      recordingStartedDuringMeeting: boolean;
      /** A prompt was shown for this meeting. */
      prompted: boolean;
      /** Event named by a prompt during this meeting, if any. */
      eventId: string | null;
    };

export interface DetectionResult {
  state: DetectionState;
  actions: DetectionAction[];
}

export function initialDetectionState(
  options: {
    config?: Partial<DetectionConfig>;
    now?: Date;
    events?: readonly CalendarEvent[];
    silenced?: readonly string[];
    recording?: boolean;
  } = {},
): DetectionState {
  return {
    config: { ...DEFAULT_DETECTION_CONFIG, ...options.config },
    now: options.now?.getTime() ?? Number.NEGATIVE_INFINITY,
    presences: [],
    recording: options.recording ?? false,
    recordingSince: null,
    silenced: options.silenced ?? [],
    events: options.events ?? [],
    lastPromptAt: null,
    promptedEventIds: [],
    prompt: null,
    meeting: null,
    promptSeq: 0,
  };
}

/** A wall clock going back further than this is a clock change (not input jitter): see `rebaseClock`. */
export const CLOCK_JUMP_MS = 60_000;

/**
 * The wall clock stepped back by more than `CLOCK_JUMP_MS` (manual change, NTP correction): shift every
 * stored time by the jump so delays, debounces and the rate limit keep their remaining durations instead of
 * freezing until real time catches up. Smaller backwards steps are treated as late input (time is clamped).
 */
export function rebaseClock(state: DetectionState, now: Date): DetectionState {
  const delta = now.getTime() - state.now;
  if (!(delta < -CLOCK_JUMP_MS)) return state;
  const shift = (t: number) => t + delta;
  const opt = (t: number | null) => (t === null ? null : shift(t));
  return {
    ...state,
    now: now.getTime(),
    presences: state.presences.map((p) => ({
      ...p,
      since: shift(p.since),
      goneSince: opt(p.goneSince),
    })),
    recordingSince: opt(state.recordingSince),
    lastPromptAt: opt(state.lastPromptAt),
    prompt: state.prompt && { ...state.prompt, shownAt: shift(state.prompt.shownAt) },
    meeting: state.meeting && { ...state.meeting, startedAt: shift(state.meeting.startedAt) },
  };
}

/** Applies `input` at `now` and every rule that has come due. Pure: `state` is not modified. */
export function detect(state: DetectionState, input: DetectionInput, now: Date): DetectionResult {
  state = rebaseClock(state, now);
  const n = Math.max(now.getTime(), state.now); // never go back in time (small steps: late input)
  const at = new Date(n);
  const { config } = state;
  const actions: DetectionAction[] = [];
  let presences = state.presences.map((p) => ({ ...p }));
  let { recording, recordingSince, silenced, events, lastPromptAt, prompt, meeting, promptSeq } =
    state;
  let promptedEventIds = state.promptedEventIds;

  const dismiss = (reason: DismissReason) => {
    if (!prompt) return;
    actions.push({ type: 'dismiss', promptId: prompt.id, at, reason });
    prompt = null;
  };

  // 1. The input.
  switch (input.type) {
    case 'micApps': {
      const seen = new Map<string, { app: MeetingApp; pid: number; bundleId: string | null }>();
      for (const proc of input.apps) {
        const app = resolveMeetingApp(proc);
        if (app && !seen.has(app.id))
          seen.set(app.id, { app, pid: proc.pid, bundleId: proc.bundleId ?? null });
      }
      for (const p of presences) {
        const s = seen.get(p.app.id);
        if (s) {
          p.goneSince = null;
          p.pid = s.pid;
          p.bundleId = s.bundleId;
        } else p.goneSince ??= n;
      }
      for (const [id, s] of seen) {
        if (presences.some((p) => p.app.id === id)) continue;
        presences.push({ ...s, since: n, goneSince: null, eligible: false, candidate: 'pending' });
      }
      break;
    }
    case 'recording':
      if (input.recording && !recording) {
        recordingSince = n;
        if (meeting) meeting = { ...meeting, recordingStarted: true };
      }
      if (!input.recording) recordingSince = null;
      recording = input.recording;
      if (recording) dismiss('recording');
      break;
    case 'calendar':
      events = input.events;
      break;
    case 'silenced':
      silenced = input.appIds;
      if (prompt && silenced.includes(prompt.appId)) dismiss('silenced');
      break;
    case 'promptClosed':
      if (prompt?.id === input.promptId) prompt = null;
      break;
    case 'tick':
      break;
  }

  // 2. Debounced removal.
  let lastGone: number | null = null;
  presences = presences.filter((p) => {
    if (p.goneSince === null || n - p.goneSince < config.goneDebounceMs) return true;
    if (p.eligible) lastGone = Math.max(lastGone ?? p.goneSince, p.goneSince);
    if (prompt?.appId === p.app.id) dismiss('app_gone');
    return false;
  });

  // 3. Eligibility.
  const event = currentMeetingFor(events, at);
  for (const p of presences) {
    if (p.eligible || p.goneSince !== null) continue;
    const held = n - p.since;
    if (held < config.promptDelayMs) continue;
    if (held < p.app.minHoldMs && !event) continue;
    if (p.app.kind === 'browser' && !event) continue;
    p.eligible = true;
  }

  // 4. Meeting span.
  const eligible = presences.filter((p) => p.eligible);
  if (eligible.length > 0) {
    const ids = eligible.map((p) => p.app.id);
    const startedAt = Math.min(...eligible.map((p) => p.since));
    if (!meeting) {
      meeting = {
        startedAt,
        appIds: ids,
        eventId: null,
        prompted: false,
        recordingStarted: recording && recordingSince !== null && recordingSince >= startedAt,
      };
    } else {
      const known = meeting.appIds;
      const added = ids.filter((id) => !known.includes(id));
      if (added.length || startedAt < meeting.startedAt) {
        const start = Math.min(meeting.startedAt, startedAt);
        meeting = {
          ...meeting,
          startedAt: start,
          appIds: [...known, ...added],
          recordingStarted:
            meeting.recordingStarted ||
            (recording && recordingSince !== null && recordingSince >= start),
        };
      }
    }
  } else if (meeting) {
    actions.push({
      type: 'meetingEnded',
      at,
      startedAt: new Date(meeting.startedAt),
      endedAt: new Date(lastGone ?? n),
      appIds: meeting.appIds,
      recording,
      recordingStartedDuringMeeting: meeting.recordingStarted,
      prompted: meeting.prompted,
      eventId: meeting.eventId,
    });
    meeting = null;
  }

  // 5. Prompt timeout.
  if (prompt && n - prompt.shownAt >= config.promptTimeoutMs) dismiss('timeout');

  // 6. Prompts for eligible presences, oldest first (native before browser on a tie).
  promptedEventIds = promptedEventIds.filter((id) =>
    events.some((e) => e.id === id && e.end.getTime() > n),
  );
  const due = presences
    .filter((p) => p.candidate === 'pending' && p.eligible && p.goneSince === null)
    .sort(
      (a, b) =>
        a.since - b.since ||
        Number(a.app.kind === 'browser') - Number(b.app.kind === 'browser') ||
        (a.app.id < b.app.id ? -1 : 1),
    );
  for (const p of due) {
    // Permanent gates.
    if (
      recording ||
      silenced.includes(p.app.id) ||
      (event && promptedEventIds.includes(event.id))
    ) {
      p.candidate = 'done';
      continue;
    }
    // Temporary gates: decide later (`nextDeadline` wakes us when the rate limit expires).
    if (prompt || (lastPromptAt !== null && n - lastPromptAt < config.rateLimitMs)) continue;
    p.candidate = 'done';
    promptSeq += 1;
    const id = `prompt-${promptSeq}`;
    prompt = { id, appId: p.app.id, eventId: event?.id ?? null, shownAt: n };
    lastPromptAt = n;
    if (event) promptedEventIds = [...promptedEventIds, event.id];
    if (meeting) meeting = { ...meeting, prompted: true, eventId: event?.id ?? meeting.eventId };
    actions.push({
      type: 'prompt',
      promptId: id,
      at,
      app: p.app,
      pid: p.pid,
      bundleId: p.bundleId,
      event,
    });
  }

  return {
    state: {
      config,
      now: n,
      presences,
      recording,
      recordingSince,
      silenced,
      events,
      lastPromptAt,
      promptedEventIds,
      prompt,
      meeting,
      promptSeq,
    },
    actions,
  };
}

/**
 * When `detect` must next be called with `{ type: 'tick' }` (epoch ms, after `state.now`), or null when
 * nothing is scheduled: a debounce expiring, a prompt delay or minimum hold passing, a prompt timing out, the
 * rate limit expiring for a deferred prompt, or — while a presence waits for the calendar — an event's
 * "starting soon" window opening.
 */
export function nextDeadline(state: DetectionState): number | null {
  const { config, now } = state;
  const times: number[] = [];
  let calendarWaiting = false;
  let deferred = false;
  for (const p of state.presences) {
    if (p.goneSince !== null) {
      times.push(p.goneSince + config.goneDebounceMs);
      continue;
    }
    if (!p.eligible) {
      times.push(p.since + config.promptDelayMs, p.since + p.app.minHoldMs);
      if (now - p.since >= config.promptDelayMs) calendarWaiting = true;
    } else if (p.candidate === 'pending') {
      deferred = true;
    }
  }
  if (state.prompt) times.push(state.prompt.shownAt + config.promptTimeoutMs);
  if (deferred && state.lastPromptAt !== null) times.push(state.lastPromptAt + config.rateLimitMs);
  if (calendarWaiting) {
    for (const e of state.events) {
      if (e.allDay || !isAttending(e)) continue;
      times.push(e.start.getTime() - CURRENT_MEETING_LEAD_MS);
    }
  }
  const future = times.filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}

/** "Weekly sync" for a calendar-named prompt, else e.g. "Slack huddle". */
export function promptTitle(action: Extract<DetectionAction, { type: 'prompt' }>): string {
  return action.event?.title || `${action.app.name} ${action.app.noun}`;
}
