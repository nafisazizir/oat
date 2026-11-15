/**
 * Small IANA time-zone helpers (Intl only, no dependencies): wall-clock ↔ instant, RFC 3339 with the zone's
 * offset (how Google Calendar writes `dateTime`), and day arithmetic for all-day events.
 */

export interface WallClock {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
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
  return f;
}

/** The wall-clock time at instant `ms` in `timeZone`. */
export function wallClock(ms: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

const wallUtc = (w: WallClock) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** `timeZone`'s offset from UTC at instant `ms`, in ms (e.g. −8 h for PST). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallUtc(wallClock(whole, timeZone)) - whole;
}

/** The instant a wall-clock time happens in `timeZone` (fields may overflow, e.g. day 35). */
export function wallToInstant(wall: WallClock, timeZone: string): number {
  const guess = wallUtc(wall);
  let t = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(t, timeZone);
  if (second !== t) t = second; // the guess straddled a DST change
  return t;
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/** `2026-11-16T09:30:00-08:00`: the local time in `timeZone` with its offset. */
export function rfc3339InZone(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  const offsetMin = Math.round(zoneOffsetMs(ms, timeZone) / 60_000);
  const sign = offsetMin < 0 ? '-' : '+';
  const off = `${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`;
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${off}`;
}

/** The same wall-clock time `days` later in `timeZone` (keeps 09:30 local across DST changes). */
export function shiftWallDays(ms: number, timeZone: string, days: number): number {
  if (days === 0) return ms;
  const w = wallClock(ms, timeZone);
  return wallToInstant({ ...w, day: w.day + days }, timeZone);
}

/** `YYYY-MM-DD` of instant `ms` in `timeZone`. */
export function dayIn(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** `YYYY-MM-DD` plus `days`. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Midnight starting `day` in `timeZone`. */
export function midnightIn(day: string, timeZone: string): number {
  const [year, month, d] = day.split('-').map(Number) as [number, number, number];
  return wallToInstant({ year, month, day: d, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Day of the week of `YYYY-MM-DD`: 0 = Sunday … 6 = Saturday. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `20261116T173000Z` (Google recurring-instance id suffix) for a timed occurrence. */
export function compactUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
