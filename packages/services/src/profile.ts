/**
 * "About me" (4.6) as AI context: what enhance and chat put in their prompts for the acting user. The
 * `/api/profile` route stays in the web app.
 */
import { type Db, getUserProfile, profileAboutMe, user } from '@oat/db';
import { eq } from 'drizzle-orm';

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
