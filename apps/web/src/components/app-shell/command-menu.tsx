'use client';

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@oat/ui/components/command';
import { useSidebar } from '@oat/ui/components/sidebar';
import {
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  LayoutTemplateIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

/** The ⌘K palette: jump to sections and pages, create a note, toggle the sidebar, switch theme. */
export function CommandMenu() {
  const { open, setOpen } = useCommandMenu();
  const router = useRouter();
  const { toggleSidebar } = useSidebar();
  const { theme, setTheme } = useTheme();
  const newNote = useNewNote();
  const { documents } = useShellData();

  const run = useCallback(
    (action: () => void) => {
      setOpen(false);
      action();
    },
    [setOpen],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or run a command"
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput placeholder="Search pages and commands…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => run(() => router.push(sections.home.href))}>
              <HomeIcon />
              {sections.home.label}
            </CommandItem>
            <CommandItem onSelect={() => run(() => router.push(sections.templates.href))}>
              <LayoutTemplateIcon />
              {sections.templates.label}
            </CommandItem>
            <CommandItem onSelect={() => run(() => router.push(sections.settings.href))}>
              <SettingsIcon />
              {sections.settings.label}
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Pages">
            {documents.map((doc) => (
              <CommandItem
                key={doc.id}
                value={`page ${titleOf(doc)} ${doc.id}`}
                onSelect={() => run(() => router.push(`/d/${doc.id}`))}
              >
                {doc.kind === 'folder' ? <FolderIcon /> : <FileTextIcon />}
                {titleOf(doc)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => run(newNote)}>
              <SquarePenIcon />
              New note
            </CommandItem>
            <CommandItem onSelect={() => run(toggleSidebar)}>
              <PanelLeftIcon />
              Toggle sidebar
              <CommandShortcut>⌘B</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Theme">
            {(
              [
                ['light', 'Light', SunIcon],
                ['dark', 'Dark', MoonIcon],
                ['system', 'System', MonitorIcon],
              ] as const
            ).map(([value, label, Icon]) => (
              <CommandItem
                key={value}
                value={`${label} theme`}
                data-checked={theme === value}
                onSelect={() => run(() => setTheme(value))}
              >
                <Icon />
                {label} theme
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
