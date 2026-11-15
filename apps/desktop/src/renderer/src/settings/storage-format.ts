/**
 * Formatting + sorting for Settings → Storage (3.8). Pure, unit-tested. Sizes are decimal (like Finder).
 */
import type { RetentionPolicy, RetentionPreview, StorageMeeting } from '@oat/core/bridge';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `0 B`, `840 KB`, `1.2 MB`, `12 GB`: one decimal below 10, none above. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // 999.6 KB rounds to "1000 KB": show "1 MB" instead.
  if (rounded >= 1000 && unit < UNITS.length - 1) return `1 ${UNITS[unit + 1]}`;
  return `${rounded} ${UNITS[unit]}`;
}

/** `45 s`, `12 min`, `1 h 05 min`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** `Nov 14, 2026, 3:04 PM`. */
export function formatWhen(ms: number): string {
  return DATE.format(ms);
}

export type StorageSort = 'newest' | 'oldest' | 'largest';

export function sortMeetings(meetings: readonly StorageMeeting[], sort: StorageSort) {
  const byDate = (a: StorageMeeting, b: StorageMeeting) => a.startedAt - b.startedAt;
  return [...meetings].sort((a, b) =>
    sort === 'largest'
      ? b.bytes - a.bytes || byDate(b, a)
      : sort === 'oldest'
        ? byDate(a, b)
        : byDate(b, a),
  );
}

export type PolicyKind = RetentionPolicy['kind'];

/** Form state → policy, or `null` while the number isn't valid. */
export function policyFromForm(kind: PolicyKind, amount: string): RetentionPolicy | null {
  if (kind === 'forever') return { kind };
  const n = Number(amount.trim().replace(',', '.'));
  if (amount.trim() === '' || !Number.isFinite(n)) return null;
  if (kind === 'age') return Number.isInteger(n) && n >= 1 && n <= 3650 ? { kind, days: n } : null;
  return n >= 0.1 && n <= 10_000 ? { kind, gb: n } : null;
}

/** The number to show in the form for a saved policy. */
export function policyAmount(policy: RetentionPolicy): string {
  return policy.kind === 'age'
    ? String(policy.days)
    : policy.kind === 'size'
      ? String(policy.gb)
      : '';
}

export function samePolicy(a: RetentionPolicy | null, b: RetentionPolicy | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One line under the policy form. */
export function describePreview(policy: RetentionPolicy, preview: RetentionPreview | null): string {
  if (policy.kind === 'forever') return 'Audio is kept until you delete it.';
  if (!preview) return 'Checking…';
  const count = `${preview.meetings} ${preview.meetings === 1 ? 'meeting' : 'meetings'}`;
  const now =
    preview.meetings === 0
      ? 'Nothing to delete right now.'
      : `Would free ${formatBytes(preview.bytes)} now (${count}).`;
  return preview.overCapAfter
    ? `${now} Still over the limit: a recording in progress and audio from the last hour are always kept.`
    : now;
}
