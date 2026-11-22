import { describe, expect, it } from 'vitest';
import { desktopSettingsSection } from './settings-section';

describe('desktop settings routes', () => {
  it.each(['members', 'workspace/members'])('opens invites at Members (%s)', (section) => {
    expect(desktopSettingsSection(section)).toBe('members');
  });
  it.each([
    'profile',
    'preferences',
    'integrations',
    'workspace',
    'recording',
    'storage',
    'setup',
  ] as const)('opens %s in app', (section) => {
    expect(desktopSettingsSection(section)).toBe(section);
  });
  it.each([undefined, '', 'not-a-section'])('defaults to Preferences for %s', (section) => {
    expect(desktopSettingsSection(section)).toBe('preferences');
  });
});
