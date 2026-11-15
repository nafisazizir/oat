// Fixed locale + UTC so server and client render the same string (no hydration mismatch).
// Per-user locale and time zone come with user settings. Month-first everywhere, matching the meeting
// header ("Thu, Nov 12 · 3:04 PM", @oat/meeting-ui), so one screen never mixes "12 Nov" and "Nov 12" (9.3).
const monthDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const monthDayYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Nov 12" (lists, "Edited …"). */
export function formatDay(date: string | Date): string {
  return monthDay.format(new Date(date));
}

/** "Nov 12, 2026" (pages read out of context: the public share page, connection dates). */
export function formatDate(date: string | Date): string {
  return monthDayYear.format(new Date(date));
}

/**
 * "9:30 – 9:45 AM" (one AM/PM when both ends share it), "11:30 AM – 12:15 PM". In the viewer's zone unless
 * `timeZone` is given, so call it on the client only (after hydration).
 */
export function formatTimeRange(start: Date, end: Date, timeZone?: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  const from = time.format(start);
  const to = time.format(end);
  const sameHalf = from.slice(-2) === to.slice(-2) && /[AP]M$/.test(from);
  return `${sameHalf ? from.slice(0, -3) : from} – ${to}`;
}
