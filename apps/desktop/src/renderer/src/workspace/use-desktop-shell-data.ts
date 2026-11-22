import type { DesktopUser, MeetingNoteSummary, WorkspacesSnapshot } from '@oat/core/bridge';
import { loadShellData, type ShellData, type DocumentNode } from '@oat/workspace-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../bridge';
import { api } from '../lib/api';
import { useApiOnline } from './api-status';

export function localShellData(
  user: DesktopUser,
  snapshot: WorkspacesSnapshot | null,
  cached?: ShellData | null,
): ShellData {
  const workspaces =
    snapshot?.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role ?? ('viewer' as const),
      members: cached?.workspaces.find((known) => known.id === w.id)?.members ?? 1,
      icon: cached?.workspaces.find((known) => known.id === w.id)?.icon,
    })) ?? [];
  const workspace = workspaces.find((w) => w.id === snapshot?.activeId) ??
    workspaces[0] ?? { id: '', name: user.name || user.email, role: 'viewer' as const, members: 1 };
  return {
    user: { ...user, name: user.name || user.email, image: null },
    workspace,
    workspaces,
    documents: [],
    trash: [],
    canJoin: false,
  };
}

export function mergeLocalNotes(shell: ShellData, notes: readonly MeetingNoteSummary[]): ShellData {
  const known = new Set([...shell.documents, ...shell.trash].map((n) => n.id));
  const local: DocumentNode[] = notes
    .filter((n) => n.workspaceId === shell.workspace.id && !known.has(n.documentId))
    .map((n) => ({
      id: n.documentId,
      title: n.title,
      kind: 'meeting',
      visibility: 'private',
      parentId: null,
      ownerId: n.ownerId,
      updatedAt: n.endedAt ?? n.startedAt ?? n.createdAt,
      access: { edit: n.ownerId === shell.user.id, delete: n.ownerId === shell.user.id },
    }));
  const localTitles = new Map(notes.map((n) => [n.documentId, n.title]));
  const documents = shell.documents.map((node) =>
    node.kind === 'meeting' && localTitles.has(node.id)
      ? { ...node, title: localTitles.get(node.id)! }
      : node,
  );
  return { ...shell, documents: [...documents, ...local] };
}

export function useDesktopShellData(
  user: DesktopUser,
  notes: readonly MeetingNoteSummary[] | null,
  snapshot: WorkspacesSnapshot | null,
  lastSyncedAt: number | null,
) {
  const [remote, setRemote] = useState<ShellData | null>(null);
  const { id, name, email } = user;
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [appOrigin, setAppOrigin] = useState('');
  const apiOnline = useApiOnline();
  const localWorkspaceId = snapshot?.activeId;
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [refresh]);
  useEffect(() => {
    void call('app:info')
      .then((info) => setAppOrigin(info.appOrigin))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    void loadShellData(api, { id, name: name || email, email, image: null }).then(
      (data) => {
        if (!active) return;
        setRemote(data);
        setFailed(false);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [id, name, email, localWorkspaceId, lastSyncedAt, revision]);
  const remoteWorkspaceId = remote?.workspace.id;
  const knownWorkspace = snapshot?.workspaces.some((w) => w.id === remoteWorkspaceId);
  useEffect(() => {
    if (knownWorkspace && remoteWorkspaceId && localWorkspaceId !== remoteWorkspaceId && !failed)
      void call('workspaces:set-active', { workspaceId: remoteWorkspaceId }).catch(() => {});
  }, [knownWorkspace, remoteWorkspaceId, localWorkspaceId, failed]);
  const local = useMemo(() => localShellData(user, snapshot, remote), [user, snapshot, remote]);
  const base = useMemo(
    () =>
      failed || !apiOnline
        ? {
            ...local,
            documents: remote?.workspace.id === local.workspace.id ? remote.documents : [],
            trash: remote?.workspace.id === local.workspace.id ? remote.trash : [],
          }
        : (remote ?? local),
    [failed, apiOnline, local, remote],
  );
  const data = useMemo(() => mergeLocalNotes(base, notes ?? []), [base, notes]);
  return { data, refresh, revision, appOrigin, online: apiOnline && !failed };
}
