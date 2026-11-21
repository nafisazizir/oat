import { describe, expect, it } from 'vitest';

import {
  audienceLabel,
  expiresIn,
  ICON_CHOICES,
  isRole,
  parseWorkspaceIcon,
  ROLES_DESC,
  workspaceIcon,
} from './workspace';

describe('parseWorkspaceIcon', () => {
  it('accepts one emoji, including multi-codepoint ones', () => {
    for (const icon of ['🌾', '🛠️', '👩🏽‍💻', '🇸🇪', '⭐']) expect(parseWorkspaceIcon(icon)).toBe(icon);
    for (const icon of ICON_CHOICES) expect(parseWorkspaceIcon(icon)).toBe(icon);
  });

  it('treats blank as no icon', () => {
    expect(parseWorkspaceIcon('')).toBeNull();
    expect(parseWorkspaceIcon('  ')).toBeNull();
    expect(parseWorkspaceIcon(null)).toBeNull();
  });

  it('refuses text, several emoji and markup', () => {
    for (const bad of ['A', 'ab', '🌾🌾', '<b>', 'https://x.test/logo.png', '1']) {
      expect(() => parseWorkspaceIcon(bad), bad).toThrow();
    }
  });

  it('workspaceIcon renders only valid stored icons', () => {
    expect(workspaceIcon('🌾')).toBe('🌾');
    expect(workspaceIcon('https://x.test/logo.png')).toBeNull();
    expect(workspaceIcon(null)).toBeNull();
  });
});

describe('roles', () => {
  it('orders roles highest first and recognises them', () => {
    expect(ROLES_DESC).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(isRole('admin')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('expiresIn', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);
  it('describes the time left', () => {
    expect(expiresIn(at(-1), now)).toBe('expired');
    expect(expiresIn(at(30 * 60_000), now)).toBe('in less than an hour');
    expect(expiresIn(at(3_600_000), now)).toBe('in 1 hour');
    expect(expiresIn(at(5 * 3_600_000), now)).toBe('in 5 hours');
    expect(expiresIn(at(25 * 3_600_000), now)).toBe('in 1 day');
    expect(expiresIn(at(36 * 3_600_000 + 1), now)).toBe('in 2 days');
    expect(expiresIn(at(7 * 86_400_000 - 5_000), now)).toBe('in 7 days');
  });
});

describe('audienceLabel', () => {
  it('never says "Shared with" a workspace nobody else is in', () => {
    expect(audienceLabel({ name: 'Ada’s workspace', members: 1 })).toBe('Only you');
    expect(audienceLabel({ name: 'Acme', members: 2 })).toBe('Shared with Acme');
    // The same workspace, once someone joined.
    expect(audienceLabel({ name: 'Ada’s workspace', members: 3 })).toBe(
      'Shared with Ada’s workspace',
    );
  });
});
