/**
 * "About me" profile queries (task 4.6). Always keyed by the session user's id: callers never pass another
 * user's id from a request (the API takes no user id at all).
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { PROFILE_LIMITS, user, userProfile } from './schema/index.ts';

export interface UserProfile {
  /** `user.name` (may be empty). */
  name: string;
  email: string;
  role: string;
  team: string;
  about: string;
  vocabulary: string[];
  /** ISO time of the last profile save, `null` if never saved. */
  updatedAt: string | null;
}

export interface UserProfileInput {
  name: string;
  role: string;
  team: string;
  about: string;
  vocabulary: readonly string[];
}

const oneLine = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);

/** Trims, collapses whitespace, caps lengths, drops empty and duplicate (case-insensitive) terms. */
export function normalizeProfileInput(
  input: UserProfileInput,
): UserProfileInput & { vocabulary: string[] } {
  const seen = new Set<string>();
  const vocabulary: string[] = [];
  for (const raw of input.vocabulary) {
    const term = oneLine(raw, PROFILE_LIMITS.vocabularyTermLength);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    vocabulary.push(term);
    if (vocabulary.length === PROFILE_LIMITS.vocabularyTerms) break;
  }
  return {
    name: oneLine(input.name, PROFILE_LIMITS.name),
    role: oneLine(input.role, PROFILE_LIMITS.role),
    team: oneLine(input.team, PROFILE_LIMITS.team),
    // Paragraphs allowed; trailing spaces and runs of blank lines are not.
    about: input.about
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, PROFILE_LIMITS.about),
    vocabulary,
  };
}

/** The user's profile (empty fields when never saved); `undefined` for an unknown user. */
export async function getUserProfile(db: Db, userId: string): Promise<UserProfile | undefined> {
  const [row] = await db
    .select({
      name: user.name,
      email: user.email,
      role: userProfile.role,
      team: userProfile.team,
      about: userProfile.about,
      vocabulary: userProfile.vocabulary,
      updatedAt: userProfile.updatedAt,
    })
    .from(user)
    .leftJoin(userProfile, eq(userProfile.userId, user.id))
    .where(eq(user.id, userId));
  if (!row) return undefined;
  return {
    name: row.name ?? '',
    email: row.email,
    role: row.role ?? '',
    team: row.team ?? '',
    about: row.about ?? '',
    vocabulary: row.vocabulary ?? [],
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** Saves the profile (normalised) and the display name, in one transaction. */
export async function saveUserProfile(
  db: Db,
  userId: string,
  input: UserProfileInput,
): Promise<UserProfile> {
  const clean = normalizeProfileInput(input);
  // Same rule as Better Auth's update-user (5.5): a display name is 1–100 characters after trimming.
  if (!clean.name) throw new RangeError('saveUserProfile: the name is required');
  await db.transaction(async (tx) => {
    await tx.update(user).set({ name: clean.name }).where(eq(user.id, userId));
    const fields = {
      role: clean.role,
      team: clean.team,
      about: clean.about,
      vocabulary: clean.vocabulary,
    };
    await tx
      .insert(userProfile)
      .values({ userId, ...fields })
      .onConflictDoUpdate({
        target: userProfile.userId,
        set: { ...fields, updatedAt: sql`now()` },
      });
  });
  const saved = await getUserProfile(db, userId);
  if (!saved) throw new Error(`saveUserProfile: no user ${userId}`);
  return saved;
}

/**
 * The profile as the AI context wants it (D-20 `buildMeetingContext` `aboutMe` + `vocabulary`): labelled
 * lines for the set fields, `null` when there's nothing to say.
 */
export function profileAboutMe(
  profile: Pick<UserProfile, 'role' | 'team' | 'about'>,
): string | null {
  const lines = [
    profile.role && `Role: ${profile.role}`,
    profile.team && `Team: ${profile.team}`,
    profile.about && `What I care about:\n${profile.about}`,
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}
