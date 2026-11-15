import type { StorageMeeting } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import {
  describePreview,
  formatBytes,
  formatDuration,
  policyAmount,
  policyFromForm,
  samePolicy,
  sortMeetings,
} from './storage-format.ts';

describe('storage formatting', () => {
  it('formats sizes in decimal units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_000)).toBe('1 KB');
    expect(formatBytes(1_250_000)).toBe('1.3 MB');
    expect(formatBytes(12_400_000)).toBe('12 MB');
    expect(formatBytes(999_600)).toBe('1 MB');
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB');
    expect(formatBytes(5e15)).toBe('5000 TB');
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(33_400)).toBe('33 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
  });

  it('sorts by date or size', () => {
    const m = (meetingId: string, startedAt: number, bytes: number) =>
      ({ meetingId, startedAt, bytes }) as StorageMeeting;
    const list = [m('a', 1, 50), m('b', 3, 10), m('c', 2, 50)];
    const ids = (s: Parameters<typeof sortMeetings>[1]) =>
      sortMeetings(list, s).map((x) => x.meetingId);
    expect(ids('newest')).toEqual(['b', 'c', 'a']);
    expect(ids('oldest')).toEqual(['a', 'c', 'b']);
    expect(ids('largest')).toEqual(['c', 'a', 'b']); // equal sizes: newest first
  });

  it('parses the policy form', () => {
    expect(policyFromForm('forever', 'x')).toEqual({ kind: 'forever' });
    expect(policyFromForm('age', '30')).toEqual({ kind: 'age', days: 30 });
    expect(policyFromForm('age', '1.5')).toBeNull();
    expect(policyFromForm('age', '0')).toBeNull();
    expect(policyFromForm('age', '')).toBeNull();
    expect(policyFromForm('size', '2,5')).toEqual({ kind: 'size', gb: 2.5 });
    expect(policyFromForm('size', '0.05')).toBeNull();
    expect(policyFromForm('size', 'abc')).toBeNull();
    expect(policyAmount({ kind: 'size', gb: 0.5 })).toBe('0.5');
    expect(policyAmount({ kind: 'forever' })).toBe('');
    expect(samePolicy({ kind: 'age', days: 3 }, { kind: 'age', days: 3 })).toBe(true);
    expect(samePolicy({ kind: 'age', days: 3 }, null)).toBe(false);
  });

  it('describes the dry run', () => {
    expect(describePreview({ kind: 'forever' }, null)).toMatch(/until you delete/);
    expect(describePreview({ kind: 'age', days: 7 }, null)).toBe('Checking…');
    const preview = {
      meetings: 2,
      bytes: 1_200_000_000,
      meetingIds: ['a', 'b'],
      overCapAfter: false,
    };
    expect(describePreview({ kind: 'age', days: 7 }, preview)).toBe(
      'Would free 1.2 GB now (2 meetings).',
    );
    expect(
      describePreview(
        { kind: 'size', gb: 1 },
        { ...preview, meetings: 0, bytes: 0, overCapAfter: true },
      ),
    ).toMatch(/^Nothing to delete right now\. Still over the limit/);
  });
});
