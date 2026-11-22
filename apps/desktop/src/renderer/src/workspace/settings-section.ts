import type { SettingsSectionId } from '@oat/settings-ui';

export function desktopSettingsSection(section?: string): SettingsSectionId {
  if (section === 'workspace/members' || section === 'members') return 'members';
  switch (section) {
    case 'profile':
    case 'preferences':
    case 'integrations':
    case 'workspace':
    case 'recording':
    case 'storage':
    case 'setup':
      return section;
    default:
      return 'preferences';
  }
}
