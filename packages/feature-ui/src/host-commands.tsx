import type { AppRoute } from '@oat/workspace-ui';
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
  IconPlayerRecord,
  IconSettings,
  IconSparkles,
  IconSun,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import type { SearchCommandGroup } from './search-dialog';

type Options = {
  navigate(route: AppRoute): void;
  documents: readonly { id: string; title: string; kind: string }[];
  toggleSidebar(): void;
  theme: string;
  setTheme(theme: 'light' | 'dark' | 'system'): void;
  newPage?(): void;
  newNote?(): void;
  startRecording?(): void;
  /** Opens the trash dialog — the palette is the way into it. */
  openTrash?(): void;
  workspaces?: readonly { id: string; name: string }[];
  activeWorkspaceId?: string;
  switchWorkspace?(id: string): void;
  nativeSettings?: boolean;
  shortcutModifier?: string;
};

export function buildHostCommands(o: Options): SearchCommandGroup[] {
  const modifier = o.shortcutModifier ?? '⌘';
  const settings: [string, string][] = [
    ['profile', 'Profile'],
    ['preferences', 'Preferences'],
    ['integrations', 'Integrations'],
    ['workspace', 'Workspace settings'],
    ['members', 'Members'],
  ];
  if (o.nativeSettings)
    settings.push(['recording', 'Recording settings'], ['storage', 'Storage'], ['setup', 'Setup']);
  return [
    {
      heading: 'Go to',
      items: [
        ...(
          [
            ['home', 'Home', IconHome],
            ['tasks', 'My tasks', IconChecklist],
            ['assistant', 'Assistant', IconSparkles],
            ['templates', 'Templates', IconLayoutGrid],
            ['settings', 'Settings', IconSettings],
          ] as const
        ).map(([view, label, Icon]) => ({
          value: label,
          text: label,
          icon: <Icon />,
          onSelect: () => o.navigate({ view }),
        })),
        ...(o.openTrash
          ? [{ value: 'Trash', text: 'Trash', icon: <IconTrash />, onSelect: o.openTrash }]
          : []),
      ],
    },
    {
      heading: 'Pages',
      items: o.documents.map((doc) => ({
        value: `page:${doc.id}`,
        documentId: doc.id,
        text: doc.title.trim() || (doc.kind === 'folder' ? 'Untitled folder' : 'Untitled'),
        icon: doc.kind === 'folder' ? <IconFolder /> : <IconFileText />,
        onSelect: () => o.navigate({ view: 'document', id: doc.id }),
      })),
    },
    {
      heading: 'Actions',
      items: [
        ...(o.newPage
          ? [{ value: 'New page', text: 'New page', icon: <IconFileText />, onSelect: o.newPage }]
          : []),
        ...(o.newNote
          ? [{ value: 'New note', text: 'New note', icon: <IconEdit />, onSelect: o.newNote }]
          : []),
        ...(o.startRecording
          ? [
              {
                value: 'Start recording',
                text: 'Start recording',
                icon: <IconPlayerRecord />,
                onSelect: o.startRecording,
                shortcut: modifier + 'N',
              },
            ]
          : []),
        {
          value: 'Toggle sidebar',
          text: 'Toggle sidebar',
          icon: <IconLayoutSidebar />,
          onSelect: o.toggleSidebar,
          shortcut: modifier + 'B',
        },
      ],
    },
    {
      heading: 'Settings',
      items: settings.map(([section, label]) => ({
        value: `settings:${section}`,
        text: label,
        icon: <IconSettings />,
        onSelect: () =>
          o.navigate({
            view: 'settings',
            ...(section === 'preferences'
              ? {}
              : {
                  section:
                    section === 'members' && !o.nativeSettings ? 'workspace/members' : section,
                }),
          }),
      })),
    },
    ...(o.switchWorkspace && (o.workspaces?.length ?? 0) > 1
      ? [
          {
            heading: 'Workspaces',
            items: o.workspaces!.map((w) => ({
              value: `workspace:${w.id}`,
              text: `Switch to ${w.name}`,
              icon: <IconUsers />,
              checked: w.id === o.activeWorkspaceId,
              onSelect: () => o.switchWorkspace!(w.id),
            })),
          },
        ]
      : []),
    {
      heading: 'Theme',
      items: (
        [
          ['light', 'Light', IconSun],
          ['dark', 'Dark', IconMoon],
          ['system', 'System', IconDeviceDesktop],
        ] as const
      ).map(([theme, label, Icon]) => ({
        value: `${label} theme`,
        text: `${label} theme`,
        icon: <Icon />,
        checked: o.theme === theme,
        onSelect: () => o.setTheme(theme),
      })),
    },
  ];
}
