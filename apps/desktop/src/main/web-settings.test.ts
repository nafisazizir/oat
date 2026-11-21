import { describe, expect, it } from 'vitest';

import { webSettingsUrl } from './web-settings.ts';

describe('web settings deep links', () => {
  it.each([
    ['profile', '/settings/profile'],
    ['preferences', '/settings'],
    ['integrations', '/settings/integrations'],
    ['workspace', '/settings/workspace'],
    ['members', '/settings/workspace/members'],
  ] as const)('opens %s on the configured origin', (section, path) => {
    expect(webSettingsUrl('https://oat.example/old?query=1', section)).toBe(
      `https://oat.example${path}`,
    );
    expect(webSettingsUrl('http://localhost:3108', section)).toBe(`http://localhost:3108${path}`);
  });

  it.each(['', 'not a URL'])('rejects an invalid base URL (%s)', (base) => {
    expect(() => webSettingsUrl(base, 'workspace')).toThrow();
  });
});
