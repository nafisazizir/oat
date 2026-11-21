'use client';

import { SearchDialog, type SearchCommandGroup } from '@oat/feature-ui/search';
import { useSidebar } from '@oat/ui/components/sidebar';
import {
  IconChecklist,
  IconDeviceDesktop,
  IconEdit,
  IconFileText,
  IconFolder,
  IconHome,
  IconLayoutGrid,
  IconLayoutSidebar,
  IconMoon,
  IconSettings,
  IconSparkles,
  IconSun,
} from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { sections } from '@/lib/navigation';
import { titleOf } from '@/lib/tree';

import { useTheme } from '../theme-provider';
import { useShellData } from './shell-data';
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
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const newNote = useNewNote();
  const { documents } = useShellData();
  const local: SearchCommandGroup[] = [
    {
      heading: 'Go to',
      items: [
        { ...sections.home, icon: <IconHome /> },
        { ...sections.tasks, icon: <IconChecklist /> },
        { ...sections.assistant, icon: <IconSparkles /> },
        { ...sections.templates, icon: <IconLayoutGrid /> },
        { ...sections.settings, icon: <IconSettings /> },
      ].map(({ label, href, icon }) => ({
        value: label,
        text: label,
        icon,
        onSelect: () => router.push(href),
      })),
    },
    {
      heading: 'Pages',
      items: documents.map((doc) => ({
        value: `page:${doc.id}`,
        documentId: doc.id,
        text: titleOf(doc),
        icon: doc.kind === 'folder' ? <IconFolder /> : <IconFileText />,
        onSelect: () => router.push(`/d/${doc.id}`),
      })),
    },
    {
      heading: 'Actions',
      items: [
        { value: 'New note', text: 'New note', icon: <IconEdit />, onSelect: newNote },
        {
          value: 'Toggle sidebar',
          text: 'Toggle sidebar',
          icon: <IconLayoutSidebar />,
          onSelect: toggleSidebar,
          shortcut: '⌘B',
        },
      ],
    },
    {
      heading: 'Theme',
      items: (
        [
          ['light', 'Light', IconSun],
          ['dark', 'Dark', IconMoon],
          ['system', 'System', IconDeviceDesktop],
        ] as const
      ).map(([value, label, Icon]) => ({
        value: `${label} theme`,
        text: `${label} theme`,
        icon: <Icon />,
        checked: theme === value,
        onSelect: () => setTheme(value),
      })),
    },
  ];
  return <SearchDialog open={open} onOpenChange={setOpen} commandGroups={local} />;
}
