/**
 * Action items from enhancement (8.4): the model's `task.owner` / `task.due` (free text, "as said in the
 * meeting") → the `taskItem` attributes `owner` ({ name, email?, userId? }) and `due` (`YYYY-MM-DD`).
 *
 * - Owner: matched by email or exact full name against everyone we know (workspace members, meeting attendees,
 *   the note-taker). Partial names ("Dana", "Lee", "Dana L.", an email's local part) are matched only against
 *   the people *in this meeting* (the note-taker + attendees; an attending member keeps their user id), never a
 *   workspace member who wasn't there. No clear match → the name as the model wrote it, no email/user id.
 * - Due: resolved against the meeting's day (in the meeting's time zone): ISO dates, "today"/"EOD",
 *   "tomorrow", weekdays ("Friday", "by next Tue"), "end of week", "next week", "end of month", "in 3 days",
 *   "Nov 20" / "20 November". Anything else stays text on the task ("— due after the offsite").
 */
import { cleanOwnerName, isIsoDate, type TaskOwner } from '@oat/editor';

import type { MeetingContext } from './context.ts';

/** Someone a task can be assigned to. */
export interface TaskPerson {
  name: string;
  email?: string | null;
  /** Set for workspace members. */
  userId?: string | null;
}

const fold = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokens = (text: string) => fold(text).replace(/[.]/g, ' ').split(' ').filter(Boolean);

function toOwner(person: TaskPerson): TaskOwner {
  const owner: TaskOwner = { name: cleanOwnerName(person.name) || (person.email ?? '') };
  if (person.email) owner.email = person.email;
  if (person.userId) owner.userId = person.userId;
  return owner;
}

/**
 * People merged by email (a participant who is also a member gets the member's user id), members first. People
 * without a name or email are dropped.
 */
export function mergeTaskPeople(...groups: readonly (readonly TaskPerson[])[]): TaskPerson[] {
  const byEmail = new Map<string, TaskPerson>();
  const out: TaskPerson[] = [];
  for (const person of groups.flat()) {
    const name = cleanOwnerName(person.name ?? '');
    const email = person.email?.trim() || null;
    if (!name && !email) continue;
    const key = email?.toLowerCase();
    const known = key ? byEmail.get(key) : undefined;
    if (known) {
      known.userId ??= person.userId ?? null;
      if (!known.name) known.name = name;
      continue;
    }
    const entry: TaskPerson = {
      name: name || email!.split('@')[0]!,
      email,
      userId: person.userId ?? null,
    };
    if (key) byEmail.set(key, entry);
    out.push(entry);
  }
  return out;
}

/** Unique match or nothing. */
const only = <T>(items: readonly T[]): T | undefined => (items.length === 1 ? items[0] : undefined);

/**
 * The owner for a name the model wrote: a known person when the match is exact or unambiguous, else the name
 * alone. `null` for an empty name.
 */
export function resolveTaskOwner(
  raw: string | undefined,
  people: readonly TaskPerson[],
  /** Who partial names may match: the meeting's people. Default `people`. */
  inMeeting: readonly TaskPerson[] = people,
): TaskOwner | null {
  const name = cleanOwnerName(raw ?? '').replace(/^@+/, '');
  if (!name) return null;
  const wanted = fold(name);

  // An email address.
  if (/^[^\s@]+@[^\s@]+$/.test(name)) {
    const person = people.find((p) => p.email?.toLowerCase() === name.toLowerCase());
    return person ? toOwner(person) : { name, email: name };
  }

  // The whole name (dedupe people listed twice under the same name).
  const exact = people.filter((p) => fold(p.name) === wanted);
  if (exact.length >= 1 && new Set(exact.map((p) => p.email ?? p.userId ?? p.name)).size === 1) {
    return toOwner(exact[0]!);
  }
  if (exact.length > 1) return { name };

  const want = tokens(name);
  if (want.length === 0) return { name };
  const candidates = inMeeting.filter((p) => {
    const have = tokens(p.name);
    if (have.length === 0) return false;
    if (want.length === 1) {
      // "Dana" → Dana Lee; "Lee" → Dana Lee; the local part of an email ("dana") too.
      const local = p.email ? fold(p.email.split('@')[0]!) : '';
      return have.includes(want[0]!) || local === want[0];
    }
    // "Dana L." → Dana Lee: every token is a prefix of the matching token, first names equal.
    if (have[0] !== want[0]) return false;
    return want.slice(1).every((t, i) => have[i + 1]?.startsWith(t));
  });
  // The same person listed twice (by email) counts once.
  const distinct = [
    ...new Map(candidates.map((p) => [p.email?.toLowerCase() ?? p.userId ?? p.name, p])),
  ];
  const person = only(distinct)?.[1];
  return person ? toOwner(person) : { name };
}

// ---------------------------------------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------------------------------------

/** The calendar day of `iso` in `timeZone` (`YYYY-MM-DD`); `null` for an unparseable time. */
export function meetingDay(iso: string | null | undefined, timeZone = 'UTC'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const toUtc = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (date: Date) => date.toISOString().slice(0, 10);
const plusDays = (day: string, n: number) => {
  const date = toUtc(day);
  date.setUTCDate(date.getUTCDate() + n);
  return fromUtc(date);
};
const weekdayOf = (day: string) => toUtc(day).getUTCDay(); // 0 = Sunday

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** The next `weekday` strictly after `base` ("Friday" said on a Friday = a week later). */
function nextWeekday(base: string, weekday: number): string {
  const diff = (weekday - weekdayOf(base) + 7) % 7 || 7;
  return plusDays(base, diff);
}

function monthDay(base: string, month: number, day: number): string | null {
  // The next occurrence on or after the meeting day: a date already past means next year's; Feb 29 means the
  // next leap year's. A day no year has (Feb 30) → null.
  const year = Number(base.slice(0, 4));
  for (let y = year; y <= year + 4; y++) {
    const candidate = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isIsoDate(candidate) && candidate >= base) return candidate;
  }
  return null;
}

/**
 * A due phrase → a day, relative to the meeting's day `base` (`YYYY-MM-DD`). `null` when it can't be read with
 * confidence (then the phrase stays on the task as text).
 */
export function resolveDueDate(raw: string | undefined, base: string | null): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
  if (iso) return isIsoDate(iso) ? iso : null;
  if (!base || !isIsoDate(base)) return null;
  const phrase = text
    .replace(/^(?:due|by|on|before|until|no later than|for)\s+/, '')
    .replace(/[.!]+$/, '')
    .trim();

  if (
    /^(?:today|tonight|this (?:morning|afternoon|evening)|(?:the )?end of (?:the )?day|eod|cob|close of business)$/.test(
      phrase,
    )
  ) {
    return base;
  }
  if (/^(?:tomorrow|tmrw|tomorrow (?:morning|afternoon|evening|eod))$/.test(phrase)) {
    return plusDays(base, 1);
  }
  if (/^(?:the )?day after tomorrow$/.test(phrase)) return plusDays(base, 2);
  if (/^(?:(?:the )?end of (?:the |this )?week|eow|this week)$/.test(phrase)) {
    const wd = weekdayOf(base);
    return wd <= 5 && wd !== 0 ? plusDays(base, 5 - wd) : nextWeekday(base, 5);
  }
  if (
    /^(?:next week|early next week|(?:the )?start of next week|(?:the )?beginning of next week)$/.test(
      phrase,
    )
  ) {
    return nextWeekday(base, 1);
  }
  if (/^(?:(?:the )?end of (?:the |this )?month|eom)$/.test(phrase)) {
    const date = toUtc(base);
    return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
  }
  const inN = /^in (\d{1,3}|a|one|two|three) (day|days|week|weeks)$/.exec(phrase);
  if (inN) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3 };
    const n = words[inN[1]!] ?? Number(inN[1]);
    return plusDays(base, inN[2]!.startsWith('week') ? n * 7 : n);
  }
  const weekday =
    /^(?:(this|next|on|by) )?([a-z]+)(?: (?:morning|afternoon|evening|eod|end of day))?$/.exec(
      phrase,
    );
  if (weekday && weekday[2]! in WEEKDAYS) {
    const target = WEEKDAYS[weekday[2]!]!;
    // "this Friday" said on a Friday is today; a bare "Friday" (or "next Friday") then means next week's.
    if (weekday[1] === 'this' && weekdayOf(base) === target) return base;
    return nextWeekday(base, target);
  }

  const md = /^(?:[a-z]+,? )?([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(phrase);
  const dm =
    /^(?:[a-z]+,? )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)\.?(?:,? (\d{4}))?$/.exec(
      phrase,
    );
  const [month, day, year] = md
    ? [MONTHS[md[1]!], Number(md[2]), md[3]]
    : dm
      ? [MONTHS[dm[2]!], Number(dm[1]), dm[3]]
      : [undefined, undefined, undefined];
  if (month && day) {
    if (year) {
      const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return isIsoDate(candidate) ? candidate : null;
    }
    return monthDay(base, month, day);
  }
  return null;
}

/** What `enhancementToDoc` needs to turn task fields into attributes. */
export interface TaskMapping {
  /** Workspace members + attendees + the note-taker (`mergeTaskPeople`): email and exact-name matches. */
  people: readonly TaskPerson[];
  /** The note-taker + this meeting's attendees (members' user ids merged in by email): partial-name matches. */
  inMeeting?: readonly TaskPerson[];
  /** The meeting's day (`meetingDay(startedAt, timeZone)`), for relative due dates. */
  meetingDay: string | null;
}

/**
 * The mapping for a prepared run: `members` (workspace members, with user ids) first, then the note-taker and
 * the meeting's attendees from the shared context; the meeting's day in its time zone.
 */
export function taskMappingFromContext(
  context: Pick<MeetingContext, 'meta' | 'me' | 'people'>,
  members: readonly TaskPerson[] = [],
): TaskMapping {
  const { colleagues, externals, unknown } = context.people;
  const memberByEmail = new Map(
    members.flatMap((m) =>
      m.email && m.userId ? [[m.email.toLowerCase(), m.userId] as const] : [],
    ),
  );
  const inMeeting = mergeTaskPeople([context.me], colleagues, externals, unknown).map((p) => ({
    ...p,
    userId: p.userId ?? (p.email ? memberByEmail.get(p.email.toLowerCase()) : undefined) ?? null,
  }));
  return {
    people: mergeTaskPeople(members, [context.me], colleagues, externals, unknown),
    inMeeting,
    meetingDay: meetingDay(context.meta.startedAt, context.meta.timeZone),
  };
}
