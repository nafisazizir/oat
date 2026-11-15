import { describe, expect, it } from 'vitest';

import { formatDate, formatDay, formatTimeRange } from './format';

describe('date formatting', () => {
  it('is month-first and UTC, so server and client agree', () => {
    expect(formatDay('2026-11-12T23:30:00Z')).toBe('Nov 12');
    expect(formatDay(new Date('2026-01-03T00:00:00Z'))).toBe('Jan 3');
    expect(formatDate('2026-11-12T23:30:00Z')).toBe('Nov 12, 2026');
  });

  it('time ranges share AM/PM when they can', () => {
    const at = (time: string) => new Date(`2026-11-16T${time}Z`);
    expect(formatTimeRange(at('09:30:00'), at('09:45:00'), 'UTC')).toBe('9:30 – 9:45 AM');
    expect(formatTimeRange(at('11:30:00'), at('12:15:00'), 'UTC')).toBe('11:30 AM – 12:15 PM');
  });
});
