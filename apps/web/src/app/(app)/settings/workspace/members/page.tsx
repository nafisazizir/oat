import type { Metadata } from 'next';

import { MembersPanel } from '@/components/workspace/members-panel';
import { getWorkspaceSettings } from '@/server/workspace-settings';

export const metadata: Metadata = { title: 'Members' };

export default async function WorkspaceMembersPage() {
  const settings = await getWorkspaceSettings();
  if (settings.workspace.kind === 'personal') return null;
  return <MembersPanel settings={settings} />;
}
