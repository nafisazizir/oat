import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import { getUserProfile } from '@oat/db';
import type { Metadata } from 'next';

import { BackLink, PageContainer, PageHeader } from '@/components/page';
import { ProfileForm } from '@/components/settings/profile-form';
import { getDb } from '@/server/db';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'About me' };

/**
 * `/settings/profile` (4.6): "About me". What the AI should know about the note-taker when it writes notes
 * and answers questions; the terms also help live transcription spell names (desktop, D-17).
 */
export default async function ProfileSettingsPage() {
  const { user } = await requireSession();
  const profile = await getUserProfile(getDb(), user.id);
  if (!profile) throw new Error('signed-in user has no row');

  return (
    <PageContainer className="gap-8">
      <PageHeader
        title="About me"
        description="Context the AI uses when it enhances your notes and answers your questions."
        eyebrow={<BackLink href="/settings">Settings</BackLink>}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Your profile</h2>
          </CardTitle>
          <CardDescription>
            Only you and the AI working for you see this. Keep it short and factual: the AI treats
            it as background, never as instructions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm profile={profile} />
        </CardContent>
      </Card>
    </PageContainer>
  );
}
