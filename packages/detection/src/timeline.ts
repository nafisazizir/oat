/**
 * Detection timelines (`fixtures/detection/*.json`): a scripted sequence of inputs plus the actions the rules
 * must produce, run on a virtual clock. The same files drive the sidecar's `mic-apps watch --fixture` replay
 * (it reads only `steps[].at` + `steps[].micApps`), so one timeline exercises Swift replay, the Node source and
 * the reducer.
 */
import { CalendarEventSchema, type CalendarEvent } from '@oat/core';
import { z } from 'zod';

import { MicAppProcessSchema } from './apps.ts';
import {
  detect,
  initialDetectionState,
  nextDeadline,
  type DetectionAction,
  type DetectionConfig,
  type DetectionInput,
  type DetectionState,
} from './detect.ts';

/** A calendar event in shorthand: everything else gets defaults (timed, confirmed, Work calendar). */
export const TimelineEventSchema = z.object({
  id: z.string(),
  title: z.string().default('Meeting'),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  /** Number of attendees besides the user (0 = solo block). */
  others: z.number().int().min(0).default(1),
  declined: z.boolean().default(false),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
  allDay: z.boolean().default(false),
});
export type TimelineEvent = z.input<typeof TimelineEventSchema>;

export const TimelineStepSchema = z
  .object({
    /** ms after `start`. Non-decreasing. */
    at: z.number().int().min(0),
    events: z.array(TimelineEventSchema).optional(),
    silenced: z.array(z.string()).optional(),
    recording: z.boolean().optional(),
    micApps: z.array(MicAppProcessSchema).optional(),
    /** Close the prompt currently on screen (user clicked it). */
    promptClosed: z.literal(true).optional(),
  })
  .strict();

/** Compact expected action: `at` is ms after `start`; ids are app / calendar ids. */
export const ExpectedActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      at: z.number(),
      type: z.literal('prompt'),
      app: z.string(),
      event: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      at: z.number(),
      type: z.literal('dismiss'),
      reason: z.enum(['app_gone', 'recording', 'silenced', 'timeout']),
    })
    .strict(),
  z
    .object({
      at: z.number(),
      type: z.literal('meetingEnded'),
      apps: z.array(z.string()),
      startedAt: z.number(),
      endedAt: z.number(),
      recording: z.boolean(),
      recordingStartedDuringMeeting: z.boolean(),
      prompted: z.boolean(),
      event: z.string().nullable(),
    })
    .strict(),
]);
export type ExpectedAction = z.infer<typeof ExpectedActionSchema>;

export const DetectionTimelineSchema = z
  .object({
    description: z.string(),
    /** Wall-clock time of `at: 0`. */
    start: z.iso.datetime({ offset: true }),
    config: z
      .object({
        goneDebounceMs: z.number(),
        promptDelayMs: z.number(),
        rateLimitMs: z.number(),
        promptTimeoutMs: z.number(),
      })
      .partial()
      .optional(),
    steps: z.array(TimelineStepSchema).min(1),
    expect: z.array(ExpectedActionSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    t.steps.forEach((s, i) => {
      if (i > 0 && s.at < t.steps[i - 1]!.at)
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'at'], message: 'at must not decrease' });
    });
  });
export type DetectionTimeline = z.infer<typeof DetectionTimelineSchema>;

/** Expands the shorthand into a full `CalendarEvent` (EventKit-shaped ids). */
export function timelineEvent(input: TimelineEvent): CalendarEvent {
  const e = TimelineEventSchema.parse(input);
  const self = {
    name: 'Me',
    email: 'me@oat.test',
    status: e.declined ? 'declined' : 'accepted',
    isSelf: true,
    isOrganizer: e.others === 0,
  } as const;
  const others = Array.from({ length: e.others }, (_, i) => ({
    name: `Guest ${i + 1}`,
    email: `guest${i + 1}@oat.test`,
    status: 'accepted' as const,
    isSelf: false,
    isOrganizer: i === 0,
  }));
  const day = (iso: string) => iso.slice(0, 10);
  return CalendarEventSchema.parse({
    id: `eventkit:${e.id}`,
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    allDayStart: e.allDay ? day(e.start) : null,
    allDayEnd: e.allDay ? day(e.end) : null,
    timeZone: e.allDay ? null : 'UTC',
    location: null,
    url: null,
    conferenceUrl: null,
    conferenceProvider: null,
    status: e.status,
    attendees: e.others === 0 ? [] : [self, ...others],
    recurrenceId: null,
    icalUid: null,
  });
}

/** Strips the `eventkit:` prefix fixtures leave off. */
const shortEventId = (id: string | null) => (id === null ? null : id.replace(/^eventkit:/, ''));

/** The fixture-comparable form of an action (`at` etc. relative to `start`). */
export function compactAction(action: DetectionAction, start: number): ExpectedAction {
  const rel = (d: Date) => d.getTime() - start;
  switch (action.type) {
    case 'prompt':
      return {
        at: rel(action.at),
        type: 'prompt',
        app: action.app.id,
        event: shortEventId(action.event?.id ?? null),
      };
    case 'dismiss':
      return { at: rel(action.at), type: 'dismiss', reason: action.reason };
    case 'meetingEnded':
      return {
        at: rel(action.at),
        type: 'meetingEnded',
        apps: [...action.appIds],
        startedAt: rel(action.startedAt),
        endedAt: rel(action.endedAt),
        recording: action.recording,
        recordingStartedDuringMeeting: action.recordingStartedDuringMeeting,
        prompted: action.prompted,
        event: shortEventId(action.eventId),
      };
  }
}

export interface TimelineRun {
  actions: DetectionAction[];
  /** `actions` in fixture form. */
  compact: ExpectedAction[];
  state: DetectionState;
}

/**
 * Runs the timeline on a virtual clock: inputs at their `at`, `tick`s at every `nextDeadline`, until no input
 * is left and nothing is scheduled. Several inputs in one step apply in the order events → silenced →
 * recording → micApps → promptClosed.
 */
export function runTimeline(
  timeline: DetectionTimeline | z.input<typeof DetectionTimelineSchema>,
  config: Partial<DetectionConfig> = {},
): TimelineRun {
  const t = DetectionTimelineSchema.parse(timeline);
  const start = Date.parse(t.start);
  let state = initialDetectionState({ config: { ...t.config, ...config }, now: new Date(start) });
  const actions: DetectionAction[] = [];
  const apply = (input: DetectionInput, at: number) => {
    const r = detect(state, input, new Date(at));
    state = r.state;
    actions.push(...r.actions);
  };

  let i = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const step = t.steps[i];
    const stepAt = step ? start + step.at : null;
    const deadline = nextDeadline(state);
    if (stepAt === null && deadline === null) break;
    if (deadline !== null && (stepAt === null || deadline < stepAt)) {
      apply({ type: 'tick' }, deadline);
      continue;
    }
    const s = step!;
    const at = stepAt!;
    if (s.events) apply({ type: 'calendar', events: s.events.map(timelineEvent) }, at);
    if (s.silenced) apply({ type: 'silenced', appIds: s.silenced }, at);
    if (s.recording !== undefined) apply({ type: 'recording', recording: s.recording }, at);
    if (s.micApps) apply({ type: 'micApps', apps: s.micApps }, at);
    if (s.promptClosed) {
      const id = state.prompt?.id;
      if (id) apply({ type: 'promptClosed', promptId: id }, at);
    }
    i++;
  }
  return { actions, compact: actions.map((a) => compactAction(a, start)), state };
}
