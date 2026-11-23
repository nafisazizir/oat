import type { OatClient } from '@oat/client';
import { documentNode, folderNode, type ShellData, type ShellUser } from './tree';

export async function loadShellData(
  client: OatClient,
  user: ShellUser,
  workspaceId?: string,
): Promise<ShellData> {
  const list = await client.workspaces.list();
  const workspaces = list.workspaces.map((w) => ({ ...w, members: w.memberCount }));
  const workspace =
    workspaces.find((w) => w.id === workspaceId) ??
    workspaces.find((w) => w.id === list.activeWorkspaceId) ??
    workspaces[0];
  if (!workspace) throw new Error('signed-in user has no workspace');
  const [folders, documents, trash, choices] = await Promise.all([
    client.folders.tree(workspace.id),
    client.documents.list({ workspaceId: workspace.id }),
    client.documents.list({ workspaceId: workspace.id, trash: true }),
    client.workspaces.joinable(),
  ]);
  return {
    user,
    workspace,
    workspaces,
    documents: [...folders.map(folderNode), ...documents.map(documentNode)],
    trash: trash.map(documentNode),
    canJoin: choices.invites.length > 0 || choices.workspaces.length > 0,
  };
}
