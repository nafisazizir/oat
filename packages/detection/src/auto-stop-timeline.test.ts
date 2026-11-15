/**
 * Every `fixtures/auto-stop/*.json` timeline (mic-apps + calendar + recording + levels, through `detect` and
 * `autoStop` together) must produce exactly its `expect` list. Each 7.5 rule has at least one fixture.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AutoStopTimelineSchema, runAutoStopTimeline } from './auto-stop-timeline.ts';

const DIR = fileURLToPath(new URL('../../../fixtures/auto-stop/', import.meta.url));
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const load = (f: string) => JSON.parse(readFileSync(DIR + f, 'utf8')) as unknown;

const RULES: Record<string, string[]> = {
  'call ends near its event end → toast, then stop': ['call-ends-at-event-end.json', 'floor.json'],
  'undo keeps recording': ['undo-keeps-recording.json'],
  'call comes back → toast goes away': ['call-resumes-during-toast.json'],
  'blips (mute, device switch, audio restart) never show anything (30 s confirmation)': [
    'call-resumes.json',
    'slack-huddle-drop.json',
    'browser-drop-late.json',
  ],
  'a resumed call keeps its strictness + event (also when detect never re-qualifies it)': [
    'call-resumes.json',
    'call-resumes-during-toast.json',
    'slack-huddle-drop.json',
    'browser-drop-late.json',
  ],
  'back-to-back meetings in one app: the next one is not a resume': ['back-to-back.json'],
  'the other side still talking → ask': ['others-still-talking.json'],
  'not clearly over → ask': ['ask-event-far.json', 'no-event.json', 'upcoming-note.json'],
  'never in the first 3 min (decided at the floor)': ['floor.json'],
  'only this recording’s call counts (7.2 contract)': [
    'in-person-call-ignored.json',
    'undo-keeps-recording.json',
  ],
  'silence fallback asks; restarts after keep; sound cancels': ['in-person-silence.json'],
  'in-person never auto-stopped unless enabled': ['in-person-silence.json', 'in-person-auto.json'],
  'setting off → ask instead': ['disabled.json'],
  'paused time is not silence': ['paused.json'],
};

describe('auto-stop fixtures', () => {
  it('finds the fixtures and every rule has one', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(10);
    for (const files of Object.values(RULES))
      for (const f of files) expect(FILES, `missing ${f}`).toContain(f);
  });

  it.each(FILES)('%s', (file) => {
    const timeline = AutoStopTimelineSchema.parse(load(file));
    const run = runAutoStopTimeline(timeline);
    expect(run.compact).toEqual(timeline.expect);
    // A finished timeline leaves nothing on screen and no recording behind.
    expect(run.state.notice).toBeNull();
    expect(run.state.recording).toBeNull();
    expect(run.detection.meeting).toBeNull();
  });
});

describe('AutoStopTimelineSchema', () => {
  const base = { description: 'x', start: '2026-11-16T17:00:00Z', expect: [] };

  it('rejects decreasing times and unknown keys', () => {
    expect(() =>
      AutoStopTimelineSchema.parse({
        ...base,
        steps: [
          { at: 5, paused: true },
          { at: 4, paused: false },
        ],
      }),
    ).toThrow(/must not decrease/);
    expect(() =>
      AutoStopTimelineSchema.parse({ ...base, steps: [{ at: 0, level: -20 }] }),
    ).toThrow();
  });
});
