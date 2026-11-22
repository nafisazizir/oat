import { SearchDialog, type SearchCommandGroup } from '@oat/feature-ui/search';
import { useFeatureUi } from '@oat/feature-ui';
import { useTheme } from '@oat/settings-ui';
import {
  IconSettings,
  IconHome,
  IconSparkles,
  IconChecklist,
  IconEdit,
  IconSun,
  IconMoon,
  IconDeviceDesktop,
} from '@tabler/icons-react';

export type DesktopSearchActions = {
  onHome(): void;
  onSettings(): void;
  onNewMeeting(): void;
  canStart: boolean;
};

export function FeatureSearch({
  open,
  onOpenChange,
  onHome,
  onSettings,
  onNewMeeting,
  canStart,
}: DesktopSearchActions & { open: boolean; onOpenChange(open: boolean): void }) {
  const { navigate } = useFeatureUi();
  const { setTheme } = useTheme();
  const commandGroups: SearchCommandGroup[] = [
    {
      heading: 'Navigate',
      items: [
        { value: 'home', text: 'Home', icon: <IconHome />, onSelect: onHome },
        {
          value: 'assistant',
          text: 'Assistant',
          icon: <IconSparkles />,
          onSelect: () => navigate({ kind: 'assistant' }),
        },
        {
          value: 'tasks',
          text: 'My tasks',
          icon: <IconChecklist />,
          onSelect: () => navigate({ kind: 'tasks' }),
        },
        { value: 'settings', text: 'Settings', icon: <IconSettings />, onSelect: onSettings },
        ...(canStart
          ? [
              {
                value: 'new-meeting',
                text: 'New meeting note',
                icon: <IconEdit />,
                onSelect: onNewMeeting,
                shortcut: '⌘N',
              },
            ]
          : []),
      ],
    },
    {
      heading: 'Theme',
      items: [
        {
          value: 'theme-light',
          text: 'Light theme',
          icon: <IconSun />,
          onSelect: () => setTheme('light'),
        },
        {
          value: 'theme-dark',
          text: 'Dark theme',
          icon: <IconMoon />,
          onSelect: () => setTheme('dark'),
        },
        {
          value: 'theme-system',
          text: 'System theme',
          icon: <IconDeviceDesktop />,
          onSelect: () => setTheme('system'),
        },
      ],
    },
  ];
  return <SearchDialog open={open} onOpenChange={onOpenChange} commandGroups={commandGroups} />;
}
