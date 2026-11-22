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
  const account = useDesktopAccountItems();
  const { active, fallback, needsWorkspace } = workspaces;
  const isMac = /Mac/.test(navigator.platform);
  return (
    <div className="contents" data-testid="signed-in">
      <AppSidebar
        headerClassName={isMac ? 'gap-1 pt-0' : undefined}
        headerRowClassName={
          isMac
            ? 'app-drag h-12 ps-18 group-data-[collapsible=icon]:ps-0 group-data-[collapsible=icon]:[&>*]:invisible [&_button]:app-no-drag [&_a]:app-no-drag'
            : undefined
        }
        primaryAction={
          <NewMeetingButton
            {...newMeeting}
            sidebar
            disabled={
              newMeeting.disabled ||
              Boolean(shell.workspace.id && workspaces.active?.id !== shell.workspace.id)
            }
          />
        }
        onSearch={() => setSearchOpen(true)}
        beforeTree={
          <div className="group-data-[collapsible=icon]:hidden">
            <ConflictsPanel refreshKey={lastSyncedAt} />
            {!host.online && (
              <span role="status" className="px-2 text-label-12 text-gray-900">
                Offline
              </span>
            )}
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
        footerExtra={syncLine}
        accountItems={account.items}
      />
      <span className="sr-only" data-testid="signed-in-email">
        {user.email}
      </span>
      <div className="sr-only">{account.feedback}</div>
      <DesktopSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onNewMeeting={newMeeting.onClick}
        canStart={!newMeeting.disabled && !newMeeting.pending}
      />
    </div>
  );
}
