/** Column helpers shared by every schema file. */
import { text, timestamp } from 'drizzle-orm/pg-core';
import { newId } from '../id.ts';

/** `id text primary key`, UUIDv7 generated in application code when not supplied. */
export const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => newId());

/** `timestamptz`, read as `Date`. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();

/** Defaults to now() and is bumped by Drizzle on every `update()` (raw SQL updates must set it). */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });
