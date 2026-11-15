/** IANA zone helpers for all-day events (Intl only). */

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallUtcMs(ms: number, timeZone: string): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}

/** Midnight starting `day` (`YYYY-MM-DD`) in `timeZone`. Throws `RangeError` for an unknown zone. */
export function midnightIn(day: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const offset = (t: number) => wallUtcMs(t, timeZone) - t;
  let t = guess - offset(guess);
  const second = guess - offset(t);
  if (second !== t) t = second; // DST change between the guess and the answer
  return new Date(t);
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
