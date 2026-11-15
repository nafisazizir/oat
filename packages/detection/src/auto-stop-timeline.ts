/**
 * Auto-stop timelines (`fixtures/auto-stop/*.json`, task 7.5): mic-apps, calendar, recording and audio-level
 * steps run through `detect` *and* `autoStop` on one virtual clock, the way the desktop wires them — detect's
 * present apps, its meeting span (call open/closed) and `meetingEnded` feed auto-stop, and a `stop` action stops the
 * recording (both reducers hear it). `expect` lists the auto-stop actions only (detection has its own fixtures).
 */
import { z } from 'zod';

import { MicAppProcessSchema } from './apps.ts';
import {
  autoStop,
  type AutoStopAction,
  type AutoStopInput,
  type AutoStopState,
  initialAutoStopState,
  nextAutoStopDeadline,
} from './auto-stop.ts';
import {
  detect,
  type DetectionInput,
  type DetectionState,
  initialDetectionState,
  nextDeadline,
} from './detect.ts';
import { TimelineEventSchema, timelineEvent } from './timeline.ts';

const AutoStopStepSchema = z
  .object({
    /** ms after `start`. Non-decreasing. */
    at: z.number().int().min(0),
    events: z.array(TimelineEventSchema).optional(),
    settings: z.object({ enabled: z.boolean(), inPerson: z.boolean() }).partial().optional(),
    /** `true` / `{ eventId }` (the note's calendar event, short id) starts recording; `false` stops it. */
    recording: z
      .union([z.boolean(), z.object({ eventId: z.string().nullable() }).strict()])
      .optional(),
    micApps: z.array(MicAppProcessSchema).optional(),
    paused: z.boolean().optional(),
    /** RMS dBFS per source; `null` = no level. Holds until the next `levels` step. */
    levels: z
      .object({ mic: z.number().nullable(), system: z.number().nullable() })
      .strict()
      .optional(),
    /** Answer what is on screen: "Keep recording" / "Keep going" (`keep`) or "Stop recording" (`stop`). */
    answer: z.enum(['keep', 'stop']).optional(),
  })
  .strict();

const ExpectedSchema = z
  .object({
    at: z.number(),
    type: z.enum(['stopping', 'stop', 'ask', 'cancel']),
    reason: z.string(),
  })
  .strict();
export type ExpectedAutoStopAction = z.infer<typeof ExpectedSchema>;

export const AutoStopTimelineSchema = z
  .object({
    description: z.string(),
    start: z.iso.datetime({ offset: true }),
    config: z
      .object({
        floorMs: z.number(),
        confirmMs: z.number(),
        eventEndWindowMs: z.number(),
        silenceMs: z.number(),
        silenceDb: z.number(),
        speechDb: z.number(),
        undoMs: z.number(),
      })
      .partial()
      .optional(),
    settings: z.object({ enabled: z.boolean(), inPerson: z.boolean() }).partial().optional(),
    steps: z.array(AutoStopStepSchema).min(1),
    expect: z.array(ExpectedSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    t.steps.forEach((s, i) => {
      if (i > 0 && s.at < t.steps[i - 1]!.at)
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'at'], message: 'at must not decrease' });
    });
  });
export type AutoStopTimeline = z.infer<typeof AutoStopTimelineSchema>;

export function compactAutoStopAction(a: AutoStopAction, start: number): ExpectedAutoStopAction {
  return { at: a.at.getTime() - start, type: a.type, reason: a.reason };
}

export interface AutoStopTimelineRun {
  actions: AutoStopAction[];
  compact: ExpectedAutoStopAction[];
  state: AutoStopState;
  detection: DetectionState;
}

/** Runs the timeline (see the module comment) until no input is left and nothing is scheduled. */
export function runAutoStopTimeline(
  timeline: AutoStopTimeline | z.input<typeof AutoStopTimelineSchema>,
): AutoStopTimelineRun {
  const t = AutoStopTimelineSchema.parse(timeline);
  const start = Date.parse(t.start);
  let det = initialDetectionState({ now: new Date(start) });
  let stop = initialAutoStopState({
    now: new Date(start),
    ...(t.config ? { config: t.config } : {}),
    ...(t.settings ? { settings: t.settings } : {}),
  });
  const actions: AutoStopAction[] = [];

  const feedStop = (input: AutoStopInput, at: number) => {
    const r = autoStop(stop, input, new Date(at));
    stop = r.state;
    for (const action of r.actions) {
      actions.push(action);
      // The host stops the recording.
      if (action.type === 'stop') setRecording(false, null, at);
    }
  };
  const present = (s: DetectionState) =>
    s.presences.filter((p) => p.goneSince === null).map((p) => p.app.id);
  const feedDetect = (input: DetectionInput, at: number) => {
    const wasOpen = det.meeting !== null;
    const wasApps = present(det).join();
    const r = detect(det, input, new Date(at));
    det = r.state;
    // Like the desktop: the apps holding the mic, then the call span, then what ended.
    if (present(det).join() !== wasApps) feedStop({ type: 'apps', appIds: present(det) }, at);
    const open = det.meeting !== null;
    if (open !== wasOpen) feedStop({ type: 'call', open }, at);
    for (const action of r.actions) {
      if (action.type === 'meetingEnded') feedStop({ type: 'meetingEnded', ended: action }, at);
    }
  };
  function setRecording(on: boolean, eventId: string | null, at: number) {
    if (on) {
      feedDetect({ type: 'recording', recording: true }, at);
      feedStop({ type: 'recording', recording: true, eventId }, at);
    } else {
      feedStop({ type: 'recording', recording: false }, at);
      feedDetect({ type: 'recording', recording: false }, at);
    }
  }

  let i = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const step = t.steps[i];
    const stepAt = step ? start + step.at : null;
    const deadlines = [nextDeadline(det), nextAutoStopDeadline(stop)].filter(
      (d): d is number => d !== null,
    );
    const deadline = deadlines.length ? Math.min(...deadlines) : null;
    if (stepAt === null && deadline === null) break;
    if (deadline !== null && (stepAt === null || deadline < stepAt)) {
      feedDetect({ type: 'tick' }, deadline);
      feedStop({ type: 'tick' }, deadline);
      continue;
    }
    const s = step!;
    const at = stepAt!;
    if (s.events) {
      const events = s.events.map(timelineEvent);
      feedDetect({ type: 'calendar', events }, at);
      feedStop({ type: 'calendar', events }, at);
    }
    if (s.settings) {
      feedStop({ type: 'settings', settings: { ...stop.settings, ...s.settings } }, at);
    }
    if (s.recording !== undefined) {
      const eventId =
        typeof s.recording === 'object' && s.recording.eventId
          ? `eventkit:${s.recording.eventId}`
          : null;
      setRecording(s.recording !== false, eventId, at);
    }
    if (s.micApps) feedDetect({ type: 'micApps', apps: s.micApps }, at);
    if (s.paused !== undefined) feedStop({ type: 'paused', paused: s.paused }, at);
    if (s.levels) feedStop({ type: 'levels', ...s.levels }, at);
    if (s.answer && stop.notice) {
      const id = stop.notice.id;
      if (s.answer === 'keep') feedStop({ type: 'keep', id }, at);
      else {
        feedStop({ type: 'answered', id }, at);
        setRecording(false, null, at);
      }
    }
    i++;
  }
  return {
    actions,
    compact: actions.map((a) => compactAutoStopAction(a, start)),
    state: stop,
    detection: det,
  };
}
