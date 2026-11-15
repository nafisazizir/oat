/**
 * Action items (8.4): a `taskItem` may carry an `owner` ({ name, email?, userId? }) and a `due` date
 * (`YYYY-MM-DD`, a calendar day with no time zone). Both are optional and additive: a task without them is
 * exactly the task it was before 8.4.
 *
 * Text forms shared by every serialiser (Markdown, Notion, the static HTML view):
 *   owner + due → `@Dana Lee, due 2026-11-20` · owner → `@Dana Lee` · due → `due 2026-11-20`
 * Markdown appends it to the task's first line in parentheses: `- [ ] Send the deck (@Dana Lee, due 2026-11-20)`.
 */

export interface TaskOwner {
  /** Display name (what the notes show). */
  name: string;
  /** When known: the person's email (an attendee, or a workspace member). */
  email?: string;
  /** When the owner is a workspace member: their user id ("assigned to me"). */
  userId?: string;
}

export interface TaskMeta {
  owner: TaskOwner | null;
  due: string | null;
}

export const MAX_OWNER_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320;
const MAX_USER_ID_LENGTH = 100;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as `YYYY-MM-DD` (2026-02-30 is not). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const isShortString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Name on one line, trimmed, at most {@link MAX_OWNER_NAME_LENGTH} characters. */
export function cleanOwnerName(name: string): string {
  return name
    .replace(/[\r\n\u2028\u2029\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_OWNER_NAME_LENGTH);
}

/**
 * Why an `owner` attribute is invalid, or `undefined` when it is valid (`null` = unassigned). Only `name`,
 * `email` and `userId` are allowed, all non-empty strings; the name is one line.
 */
export function taskOwnerError(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'owner must be an object';
  const owner = value as Record<string, unknown>;
  for (const key of Object.keys(owner)) {
    if (key !== 'name' && key !== 'email' && key !== 'userId') return `owner.${key} is not allowed`;
  }
  if (
    !isShortString(owner.name, MAX_OWNER_NAME_LENGTH) ||
    cleanOwnerName(owner.name) !== owner.name
  ) {
    return 'owner.name must be a non-empty single line';
  }
  if (
    owner.email !== undefined &&
    (!isShortString(owner.email, MAX_EMAIL_LENGTH) || !/^[^\s@]+@[^\s@]+$/.test(owner.email))
  ) {
    return 'owner.email must be an email address';
  }
  if (owner.userId !== undefined && !isShortString(owner.userId, MAX_USER_ID_LENGTH)) {
    return 'owner.userId must be a non-empty string';
  }
  return undefined;
}

export function isTaskOwner(value: unknown): value is TaskOwner {
  return value !== null && value !== undefined && taskOwnerError(value) === undefined;
}

/**
 * A valid owner from anything (pasted HTML, model output), or `null`: the name is cleaned, unknown keys and
 * invalid email/userId are dropped.
 */
export function normalizeTaskOwner(value: unknown): TaskOwner | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? cleanOwnerName(raw.name) : '';
  if (!name) return null;
  const owner: TaskOwner = { name };
  if (typeof raw.email === 'string' && taskOwnerError({ name, email: raw.email }) === undefined) {
    owner.email = raw.email;
  }
  if (
    typeof raw.userId === 'string' &&
    taskOwnerError({ name, userId: raw.userId }) === undefined
  ) {
    owner.userId = raw.userId;
  }
  return owner;
}

/** The task's meta from a node's attrs (invalid values read as absent). */
export function taskMetaOf(attrs: Record<string, unknown> | undefined | null): TaskMeta {
  const owner = attrs?.owner;
  const due = attrs?.due;
  return { owner: isTaskOwner(owner) ? owner : null, due: isIsoDate(due) ? due : null };
}

/** `@Dana Lee, due 2026-11-20` (either part alone, or `''`). Plain text: callers escape for their format. */
export function formatTaskMeta(meta: TaskMeta): string {
  const parts: string[] = [];
  if (meta.owner) parts.push(`@${meta.owner.name}`);
  if (meta.due) parts.push(`due ${meta.due}`);
  return parts.join(', ');
}
