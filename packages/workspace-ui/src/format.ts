const monthDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatDay(date: string | Date): string {
  return monthDay.format(new Date(date));
}
