import {
  ensureFirstWorkspace,
  getJoinChoices,
  hasJoinChoices,
  listUserWorkspaces,
} from '@oat/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { WebJoinWorkspace } from '@/components/workspace/join-choices';
import { getDb } from '@/server/db';
import { requireSession } from '@/server/session';

export const metadata: Metadata = {
  title: 'Join a workspace',
  robots: { index: false, follow: false },
};

/**
 * Where a signed-in user without a workspace chooses one (D-36; D-35: one calm column, not a wizard):
 * invitations to their address and workspaces that are open to the domain of their verified email, with
 * "Create my own workspace" as the alternative. With nothing to choose from they never see it — they go
 * straight into a workspace made for them.
 *
 * Someone who already has a workspace reaches it from the workspace menu ("Join a workspace", shown only
 * while there is something to join): the same list, with a way back instead of "Create my own workspace".
 * With nothing to choose from they go Home.
 */
export default async function JoinPage() {
  const { user } = await requireSession();
  const db = getDb();
  const member = (await listUserWorkspaces(db, user.id)).length > 0;
  const choices = await getJoinChoices(db, user.id);
  if (!hasJoinChoices(choices)) {
    if (!member) await ensureFirstWorkspace(db, user.id);
    redirect('/home');
  }

  return <WebJoinWorkspace email={user.email} initial={{ member, choices }} />;
}
