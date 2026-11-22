import type { DesktopUser } from '@oat/core/bridge';
import { AppSidebar, useShellData, useWorkspaceHost } from '@oat/workspace-ui';
import { useState, type ReactNode } from 'react';
import { NewMeetingButton } from '../meetings/meeting-list';
import { ConflictsPanel } from '../sync/conflicts-panel';
import { DesktopSearch } from '../windows/shell-menus';
import { useDesktopAccountItems } from './desktop-account-items';
import type { WorkspacesView } from '../workspaces/workspaces-state';

export function DesktopSidebar({
  user,
  lastSyncedAt,
  newMeeting,
  syncLine,
  workspaces,
}: {
  user: DesktopUser;
  lastSyncedAt: number | null;
  newMeeting: React.ComponentProps<typeof NewMeetingButton>;
  syncLine: ReactNode;
  workspaces: WorkspacesView;
}) {
  const host = useWorkspaceHost();
  const shell = useShellData();
  const [searchOpen, setSearchOpen] = useState(false);
  const account = useDesktopAccountItems(user, (section) =>
    host.navigate({ view: 'settings', section }),
  );
  const { active, fallback, needsWorkspace } = workspaces;
  return (
    <div className="contents" data-testid="signed-in">
      <AppSidebar
        top={<div className="app-drag h-12 shrink-0" />}
        primaryAction={
          <div className="app-no-drag group-data-[collapsible=icon]:[&_button]:size-8 group-data-[collapsible=icon]:[&_button]:p-0 group-data-[collapsible=icon]:[&_button>span]:hidden">
            <NewMeetingButton
              {...newMeeting}
              disabled={
                newMeeting.disabled ||
                Boolean(shell.workspace.id && workspaces.active?.id !== shell.workspace.id)
              }
            />
          </div>
        }
        onSearch={() => setSearchOpen(true)}
        beforeTree={
          <div className="group-data-[collapsible=icon]:hidden">
            <ConflictsPanel refreshKey={lastSyncedAt} />
            {(fallback || needsWorkspace) && (
              <p
                role="note"
                className="px-2 text-copy-13 text-gray-900"
                data-testid="workspace-hint"
              >
                {active
                  ? `You can view ${active.name} but not add notes to it. ${fallback ? `New notes go to ${fallback.name}.` : 'Create a workspace to take notes.'}`
                  : 'Create a workspace to take notes.'}
              </p>
            )}
          </div>
        }
        footerExtra={
          <>
            {syncLine}
            <span className="sr-only" data-testid="signed-in-email">
              {user.email}
            </span>
            <div className="sr-only">{account.feedback}</div>
            {!host.online && (
              <span role="status" className="text-label-12 text-gray-900">
                Offline
              </span>
            )}
          </>
        }
        accountItems={account.items}
      />
      <DesktopSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        refreshKey={lastSyncedAt}
        onOpen={(hit) => {
          if (hit.kind === 'meeting')
            host.navigate({ view: 'document', id: hit.documentId, query: { kind: 'meeting' } });
        }}
      />
    </div>
  );
}
