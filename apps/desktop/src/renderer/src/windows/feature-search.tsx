import { SearchDialog } from '@oat/feature-ui/search';
import { buildHostCommands } from '@oat/feature-ui';
import { useTheme } from '@oat/settings-ui';
import { useShellData, useWorkspaceHost, useTreeActions } from '@oat/workspace-ui';
import { useSidebar } from '@oat/ui/components/sidebar';
import { toast } from 'sonner';

export type DesktopSearchActions = {
  onNewMeeting(): void;
  canStart: boolean;
};

export function FeatureSearch({
  open,
  onOpenChange,
  onNewMeeting,
  canStart,
}: DesktopSearchActions & { open: boolean; onOpenChange(open: boolean): void }) {
  const host = useWorkspaceHost();
  const shell = useShellData();
  const tree = useTreeActions();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const commandGroups = buildHostCommands({
    navigate: host.navigate,
    documents: shell.documents,
    workspaces: shell.workspaces,
    activeWorkspaceId: shell.workspace.id,
    theme,
    setTheme,
    toggleSidebar,
    nativeSettings: true,
    shortcutModifier: /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+',
    newPage: tree.canCreate
      ? () => void tree.newPage({ kind: 'page', area: 'private' })
      : undefined,
    startRecording: canStart ? onNewMeeting : undefined,
    openTrash: tree.openTrash,
    switchWorkspace: (workspaceId) => {
      void host.client.workspaces
        .switchActive(workspaceId)
        .then(() => {
          host.navigate({ view: 'home' });
          host.refresh();
        })
        .catch(() => toast.error('Couldn’t switch workspace. Try again.'));
    },
  });
  return <SearchDialog open={open} onOpenChange={onOpenChange} commandGroups={commandGroups} />;
}
