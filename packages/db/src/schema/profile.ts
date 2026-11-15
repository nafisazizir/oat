/**
 * "About me" (task 4.6): what the AI should know about the note-taker. One row per user, private to them;
 * the display name stays on `user.name`. Server-only (not synced, no change log): enhance and chat read it on
 * the server, and the desktop gets the vocabulary as STT keyterms with its token (D-17).
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { timestamps } from './columns.ts';

/** Length limits, enforced by the API and again by check constraints. */
export const PROFILE_LIMITS = {
  name: 100,
  role: 100,
  team: 100,
  about: 1000,
  /** Terms and names to spell correctly. */
  vocabularyTerms: 100,
  vocabularyTermLength: 60,
} as const;

export const userProfile = pgTable(
  'user_profile',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default(''),
    team: text('team').notNull().default(''),
    /** "What I care about": free text. */
    about: text('about').notNull().default(''),
    vocabulary: text('vocabulary')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps(),
  },
  (t) => [
    check(
      'user_profile_lengths_ck',
      sql`char_length(${t.role}) <= ${sql.raw(String(PROFILE_LIMITS.role))} and char_length(${t.team}) <= ${sql.raw(String(PROFILE_LIMITS.team))} and char_length(${t.about}) <= ${sql.raw(String(PROFILE_LIMITS.about))} and coalesce(array_length(${t.vocabulary}, 1), 0) <= ${sql.raw(String(PROFILE_LIMITS.vocabularyTerms))}`,
    ),
  ],
);
