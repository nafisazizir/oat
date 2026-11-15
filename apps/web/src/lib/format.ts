// Fixed locale + UTC so server and client render the same string (no hydration mismatch).
// Per-user locale and time zone come with user settings.
const dayMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** "12 Nov" */
export function formatDay(iso: string): string {
  return dayMonth.format(new Date(iso));
}
