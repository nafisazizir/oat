import { describe, expect, it } from 'vitest';

import { parseEvents } from './fixture-source.ts';
import { mergeCalendarEvents } from './merge.ts';
import { eventInput } from './testing/events.ts';

describe('mergeCalendarEvents', () => {
  const ek = parseEvents([
    eventInput('standup', '2026-11-16T17:30:00Z', { icalUid: 'standup@x' }),
    eventInput('lunch', '2026-11-16T20:00:00Z'),
  ]);
  const google = parseEvents([
    eventInput('g-standup', '2026-11-16T17:30:00Z', { icalUid: 'standup@x', source: 'google' }),
    eventInput('g-standup-tue', '2026-11-17T17:30:00Z', { icalUid: 'standup@x', source: 'google' }),
    eventInput('g-review', '2026-11-16T19:00:00Z', { icalUid: 'review@x', source: 'google' }),
    eventInput('g-review-copy', '2026-11-16T19:00:00Z', { icalUid: 'review@x', source: 'google' }),
    eventInput('g-lunch', '2026-11-16T20:00:00Z', { source: 'google' }),
  ]);

  it('keeps one copy per meeting occurrence (same iCal UID and start), the first list winning', () => {
    const merged = mergeCalendarEvents([ek, google]);
    expect(merged.map((e) => e.title)).toEqual([
      'standup',
      'g-review',
      'g-lunch', // no iCal UID: never merged
      'lunch',
      'g-standup-tue',
    ]);
  });

  it('is sorted and handles empty input', () => {
    expect(mergeCalendarEvents([])).toEqual([]);
    const merged = mergeCalendarEvents([google, ek]);
    expect(merged[0]!.title).toBe('g-standup');
    expect(merged.map((e) => e.start.getTime())).toEqual(
      merged.map((e) => e.start.getTime()).sort((a, b) => a - b),
    );
  });
});
