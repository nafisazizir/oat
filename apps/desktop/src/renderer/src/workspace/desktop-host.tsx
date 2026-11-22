import type { DesktopUser, MeetingNoteSummary, WorkspacesSnapshot } from '@oat/core/bridge';
import {
  WorkspaceHost,
  useWorkspaceHost,
  ShellDataProvider,
  TreeActionsProvider,
  hrefOf,
  type AppRoute,
} from '@oat/workspace-ui';
import { createContext, useContext, useMemo, type ReactNode, type ComponentProps } from 'react';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { call } from '../bridge';
import { api } from '../lib/api';
import { useDesktopShellData } from './use-desktop-shell-data';

const MeetingLinks = createContext<{
  notes: readonly MeetingNoteSummary[] | null;
  recordingMeetingId: string | null;
}>({ notes: null, recordingMeetingId: null });

function DesktopLink({
  route: target,
  onClick,
  children,
  ...props
}: ComponentProps<WorkspaceHost['Link']>) {
  const { navigate } = useWorkspaceHost();
  const { notes, recordingMeetingId } = useContext(MeetingLinks);
  const note = target.view === 'document' ? notes?.find((n) => n.documentId === target.id) : null;
  return (
    <a
      {...props}
      href={'#' + hrefOf(target)}
      {...(target.view === 'home'
        ? { 'data-testid': 'home-nav' }
        : note
          ? { 'data-testid': 'meeting-list-item', 'data-document-id': note.documentId }
          : {})}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          (!props.target || props.target === '_self') &&
          !props.download
        ) {
          event.preventDefault();
          navigate(target);
        }
      }}
    >
      {children}
      {note?.meetingId && note.meetingId === recordingMeetingId && (
        <span aria-label="Recording" className="size-1.5 shrink-0 rounded-full bg-red-900" />
      )}
    </a>
  );
}

export function DesktopWorkspaceHost({
  user,
  notes,
  snapshot,
  lastSyncedAt,
  route,
  navigate,
  children,
  recordingMeetingId,
  recordingActive = false,
}: {
  user: DesktopUser;
  notes: readonly MeetingNoteSummary[] | null;
  snapshot: WorkspacesSnapshot | null;
  lastSyncedAt: number | null;
  route: AppRoute;
  navigate: (route: AppRoute) => void;
  children: ReactNode;
  recordingMeetingId: string | null;
  recordingActive?: boolean;
}) {
  const shell = useDesktopShellData(user, notes, snapshot, lastSyncedAt);
  const host = useMemo<WorkspaceHost>(
    () => ({
      platform: 'desktop',
      client: api,
      route,
      navigate,
      hrefOf,
      refresh: shell.refresh,
      online: shell.online,
      appOrigin: shell.appOrigin,
      Link: DesktopLink,
      exportNotes: async (workspaceId) =>
        (await call('settings:export-notes', { workspaceId }))?.count ?? null,
      workspaceExitBlockedReason: recordingActive
        ? 'Stop recording before leaving or deleting a workspace.'
        : undefined,
    }),
    [route, navigate, shell.refresh, shell.online, shell.appOrigin, recordingActive],
  );
  return (
    <MeetingLinks.Provider value={{ notes, recordingMeetingId }}>
      <WorkspaceHost value={host}>
        <ShellDataProvider value={shell.data}>
          <TreeActionsProvider>
            <SidebarProvider className="h-full min-h-0 min-w-0 flex-1" data-testid="shell">
              {children}
            </SidebarProvider>
          </TreeActionsProvider>
        </ShellDataProvider>
      </WorkspaceHost>
    </MeetingLinks.Provider>
  );
}
