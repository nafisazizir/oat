/**
 * Due dates of action items (8.4) are calendar days (`YYYY-MM-DD`) with no time zone: "due Friday" means Friday
 * wherever you are. These helpers compare and label them against the viewer's local "today".
 */
import { isIsoDate } from './task-meta.ts';

/** `date` as a local calendar day `YYYY-MM-DD`. */
export function localDay(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `day` + `n` days (`YYYY-MM-DD` in, out; calendar arithmetic, no DST surprises). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

/** Days from `today` to `due` (negative = overdue). */
export function daysUntil(due: string, today: string): number {
  const toUtc = (day: string) => {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(due) - toUtc(today)) / 86_400_000);
}

/** The Monday after `today` (a week from today when today is Monday). */
export function nextMonday(today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(today, (8 - weekday) % 7 || 7);
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later';

/** How urgent a due day is: before today, today, within the next 7 days, or later. */
export function dueState(due: string, today: string): DueState {
  const days = daysUntil(due, today);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'soon';
  return 'later';
}

/**
 * Short label: "Today", "Tomorrow", "Yesterday", a weekday within the coming week ("Fri"), else "Nov 20"
 * (with the year when it isn't this year's).
 */
export function formatDue(due: string, today: string, locale?: string): string {
  if (!isIsoDate(due)) return due;
  const days = daysUntil(due, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (days > 1 && days < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(date);
  }
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(date);
}
