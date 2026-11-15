/**
 * "About me" (task 4.6): `GET` / `PUT /api/profile` (contract: `src/lib/profile.ts`), and the profile as AI
 * context for enhance and chat. Always the session user's own row: the API takes no user id, so there is no
 * way to address someone else's profile.
 */
import { getUserProfile, saveUserProfile } from '@oat/db';
import { z } from 'zod';

import { PROFILE_LIMITS, type ProfileDto } from '@/lib/profile';

import { notFound } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';

/** The profile as AI context lives in `@oat/services` (8.3: the background agents use it too). */
export { type AiProfile, aiProfile, profileKeyterms } from '@oat/services/profile';

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
