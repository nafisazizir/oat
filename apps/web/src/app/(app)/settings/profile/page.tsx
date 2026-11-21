import { getUserProfile } from '@oat/db';
import type { Metadata } from 'next';

import { SettingsHeading } from '@/components/settings/section';
import { ProfileForm } from '@/components/settings/profile-form';
import { getDb } from '@/server/db';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'Profile' };

/**
 * `/settings/profile` (4.6): "About me". What the AI should know about the note-taker when it writes notes
 * and answers questions; the terms also help live transcription spell names (desktop, D-17).
 */
export default async function ProfileSettingsPage() {
  const { user } = await requireSession();
  const profile = await getUserProfile(getDb(), user.id);
  if (!profile) throw new Error('signed-in user has no row');

  return (
    <>
      <SettingsHeading>Profile</SettingsHeading>
      <ProfileForm profile={profile} />
    </>
  );
}
