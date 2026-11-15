/**
 * Every `fixtures/detection/*.json` timeline, run on a virtual clock, must produce exactly its `expect` list.
 * Each D-21 rule has at least one fixture (see RULES below), so a rule change shows up as a fixture diff.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DetectionTimelineSchema, runTimeline, timelineEvent } from './timeline.ts';

const DIR = fileURLToPath(new URL('../../../fixtures/detection/', import.meta.url));
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const load = (f: string) => JSON.parse(readFileSync(DIR + f, 'utf8')) as unknown;

/** Rule → fixtures exercising it. */
const RULES: Record<string, string[]> = {
  'allowlist (non-meeting apps ignored)': [
    'short-grab.json',
    'helpers.json',
    'sidecar-replay.json',
  ],
  'helper → parent mapping / folding': [
    'helpers.json',
    'browser-no-calendar.json',
    'rate-limit.json',
  ],
  'appear immediately, gone after 2 s': ['debounce-flap.json', 'zoom-basic.json'],
  '2 s prompt delay (short grabs never prompt)': ['short-grab.json', 'sidecar-replay.json'],
  '2-min rate limit': ['rate-limit.json', 'debounce-flap.json'],
  'temporary gates defer (prompt later, with calendar name)': ['deferred-prompt.json'],
  'per-app minimum hold (voice notes)': ['voice-note.json', 'helpers.json', 'rate-limit.json'],
  'meeting span only for eligible presences': [
    'voice-note.json',
    'short-grab.json',
    'browser-no-calendar.json',
  ],
  'recordingStartedDuringMeeting / prompted': ['recording.json', 'voice-note.json'],
  'no prompt while recording': ['recording.json'],
  'per-app silence': ['silenced.json'],
  'browsers only with calendar overlap': ['browser-no-calendar.json', 'browser-calendar.json'],
  'calendar names the meeting': ['calendar-names.json', 'browser-calendar.json'],
  'one prompt per event': ['browser-calendar.json'],
  'prompt timeout': ['calendar-names.json', 'helpers.json'],
  meetingEnded: ['zoom-basic.json', 'recording.json', 'browser-calendar.json'],
};

describe('detection fixtures', () => {
  it('finds the fixtures and every rule has one', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
    for (const files of Object.values(RULES))
      for (const f of files) expect(FILES, `missing ${f}`).toContain(f);
  });

  it.each(FILES)('%s', (file) => {
    const timeline = DetectionTimelineSchema.parse(load(file));
    const run = runTimeline(timeline);
    expect(run.compact).toEqual(timeline.expect);
    // A finished timeline leaves no meeting and nothing scheduled behind.
    expect(run.state.meeting).toBeNull();
    expect(run.state.presences).toEqual([]);
  });
});

describe('DetectionTimelineSchema', () => {
  const base = { description: 'x', start: '2026-11-16T17:00:00Z', expect: [] };

  it('rejects decreasing times, unknown keys and bad expectations', () => {
    expect(() =>
      DetectionTimelineSchema.parse({
        ...base,
        steps: [
          { at: 5, micApps: [] },
          { at: 4, micApps: [] },
        ],
      }),
    ).toThrow(/must not decrease/);
    expect(() => DetectionTimelineSchema.parse({ ...base, steps: [{ at: 0, mic: [] }] })).toThrow();
    expect(() =>
      DetectionTimelineSchema.parse({
        ...base,
        steps: [{ at: 0 }],
        expect: [{ at: 0, type: 'dismiss', reason: 'bored' }],
      }),
    ).toThrow();
  });

  it('expands shorthand events into valid CalendarEvents', () => {
    const solo = timelineEvent({
      id: 'focus',
      start: '2026-11-16T17:00:00Z',
      end: '2026-11-16T18:00:00Z',
      others: 0,
    });
    expect(solo).toMatchObject({ id: 'eventkit:focus', title: 'Meeting', attendees: [] });
    const declined = timelineEvent({
      id: 'crit',
      start: '2026-11-16T17:00:00Z',
      end: '2026-11-16T18:00:00Z',
      others: 2,
      declined: true,
    });
    expect(declined.attendees).toHaveLength(3);
    expect(declined.attendees.find((a) => a.isSelf)?.status).toBe('declined');
    const allDay = timelineEvent({
      id: 'off',
      start: '2026-11-16T00:00:00Z',
      end: '2026-11-17T00:00:00Z',
      allDay: true,
    });
    expect(allDay).toMatchObject({ allDayStart: '2026-11-16', allDayEnd: '2026-11-17' });
  });
});
