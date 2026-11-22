'use client';

import { SearchDialog } from '@oat/feature-ui/search';
import { buildHostCommands } from '@oat/feature-ui';
import { useWorkspaceHost, useTreeActions } from '@oat/workspace-ui';
import { toast } from 'sonner';
import { useSidebar } from '@oat/ui/components/sidebar';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { useTheme } from '../theme-provider';
import { useShellData } from '@oat/workspace-ui/shell-data';
import { useNewNote } from './use-new-note';

type CommandMenuContextValue = { open: boolean; setOpen: (open: boolean) => void };

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null);

export function useCommandMenu() {
  const context = useContext(CommandMenuContext);
  if (!context) throw new Error('useCommandMenu must be used within a CommandMenuProvider.');
  return context;
}

/** Holds the palette's open state and binds ⌘K / Ctrl+K anywhere in the app (including inputs). */
export function CommandMenuProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>;
}

export function CommandMenu() {
  const { open, setOpen } = useCommandMenu();
  const host = useWorkspaceHost();
  const tree = useTreeActions();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const newNote = useNewNote();
  const { documents, workspaces, workspace } = useShellData();
  const local = buildHostCommands({
    navigate: host.navigate,
    documents,
    workspaces,
    activeWorkspaceId: workspace.id,
    toggleSidebar,
    theme,
    setTheme,
    newPage: tree.canCreate
      ? () => void tree.newPage({ kind: 'page', area: 'private' })
      : undefined,
    newNote: tree.canCreate ? newNote : undefined,
    switchWorkspace: (id) => {
      void host.client.workspaces
        .switchActive(id)
        .then(() => {
          host.navigate({ view: 'home' });
          host.refresh();
        })
        .catch(() => toast.error('Couldn’t switch workspace. Try again.'));
    },
  });
  return <SearchDialog open={open} onOpenChange={setOpen} commandGroups={local} />;
}
