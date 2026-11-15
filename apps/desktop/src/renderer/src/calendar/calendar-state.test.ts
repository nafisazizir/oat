import type { UpcomingEvent } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { formatRange, groupByDay } from './calendar-state.ts';

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

const event = (id: string, start: string): UpcomingEvent => ({
  id,
  source: 'eventkit',
  title: id,
  start,
  end: start,
  calendarTitle: 'Work',
  calendarColor: null,
  others: 1,
  conferenceUrl: null,
  conferenceProvider: null,
  documentId: null,
});

describe('groupByDay', () => {
  it('groups into Today / Tomorrow (local dates); in progress since yesterday counts as today', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    const groups = groupByDay(
      [
        event('overnight', at(2026, 11, 15, 23)),
        event('review', at(2026, 11, 16, 16)),
        event('standup', at(2026, 11, 17, 9, 30)),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.events.map((e) => e.id)])).toEqual([
      ['Today', ['overnight', 'review']],
      ['Tomorrow', ['standup']],
    ]);
  });
});

describe('formatRange', () => {
  it('shortens a shared AM/PM', () => {
    expect(formatRange(at(2026, 11, 16, 15), at(2026, 11, 16, 15, 30)).replace(/\s/g, ' ')).toBe(
      '3:00 – 3:30 PM',
    );
    expect(formatRange(at(2026, 11, 16, 11), at(2026, 11, 16, 12)).replace(/\s/g, ' ')).toBe(
      '11:00 AM – 12:00 PM',
    );
  });
});
