/**
 * "About me" (task 4.6): `GET` / `PUT /api/profile` (contract: `src/lib/profile.ts`), and the profile as AI
 * context for enhance and chat. Always the session user's own row: the API takes no user id, so there is no
 * way to address someone else's profile.
 */
import { type Db, getUserProfile, profileAboutMe, saveUserProfile, user } from '@oat/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { PROFILE_LIMITS, type ProfileDto } from '@/lib/profile';

import { notFound } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';

const text = (max: number, label: string) =>
  z.string().max(max, `${label}: keep it under ${max} characters.`);

const ProfileBody = z.strictObject({
  // Same rule as Better Auth's update-user (5.5): trimmed, 1–100 characters.
  name: z
    .string()
    .trim()
    .min(1, 'Name: enter your name.')
    .max(PROFILE_LIMITS.name, `Name: keep it under ${PROFILE_LIMITS.name} characters.`),
  role: text(PROFILE_LIMITS.role, 'Role'),
  team: text(PROFILE_LIMITS.team, 'Team'),
  about: text(PROFILE_LIMITS.about, 'What you care about'),
  vocabulary: z
    .array(text(PROFILE_LIMITS.vocabularyTermLength, 'Each term'))
    .max(
      PROFILE_LIMITS.vocabularyTerms,
      `Terms: at most ${PROFILE_LIMITS.vocabularyTerms} names and terms.`,
    ),
});

/** What enhance and chat pass to `buildMeetingContext` / the assistant for the acting user. */
export type AiProfile = {
  me: { name: string; email: string | null };
  aboutMe: string | null;
  vocabulary: string[];
};

/** The acting user's name, profile text and vocabulary for AI prompts (empty profile → nulls). */
export async function aiProfile(db: Db, userId: string): Promise<AiProfile> {
  const profile = await getUserProfile(db, userId);
  if (!profile) {
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    return {
      me: { name: row?.email.split('@')[0] || 'Me', email: row?.email ?? null },
      aboutMe: null,
      vocabulary: [],
    };
  }
  return {
    me: {
      name: profile.name.trim() || profile.email.split('@')[0] || 'Me',
      email: profile.email,
    },
    aboutMe: profileAboutMe(profile),
    vocabulary: profile.vocabulary,
  };
}

/** The profile vocabulary (STT keyterms); empty for an unknown user. */
export async function profileKeyterms(db: Db, userId: string): Promise<string[]> {
  return (await getUserProfile(db, userId))?.vocabulary ?? [];
}

export function createProfileApi(deps: ApiDeps) {
  return {
    /** `/api/profile` */
    profile: {
      GET: apiRoute(deps, async ({ db, actor }): Promise<ProfileDto> => {
        const profile = await getUserProfile(db, actor.userId);
        if (!profile) throw notFound('Profile');
        return profile;
      }),
      PUT: apiRoute(deps, async ({ db, actor, request }): Promise<ProfileDto> => {
        const body = await readJson(request, ProfileBody);
        return saveUserProfile(db, actor.userId, body);
      }),
    },
  };
}

export type ProfileApi = ReturnType<typeof createProfileApi>;
