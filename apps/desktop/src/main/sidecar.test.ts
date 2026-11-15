import { describe, expect, it } from 'vitest';

import { sidecarLocateOptions } from './sidecar.ts';

describe('sidecarLocateOptions', () => {
  const env = { OAT_AUDIO_BIN: '/tmp/evil', PATH: '/usr/bin' };

  it('dev keeps OAT_AUDIO_BIN', () => {
    expect(sidecarLocateOptions({ isPackaged: false, env })).toEqual({ env });
  });

  it('a packaged app ignores OAT_AUDIO_BIN and uses its resources', () => {
    const options = sidecarLocateOptions({
      isPackaged: true,
      env,
      resourcesPath: '/Applications/Oat.app/Contents/Resources',
    });
    expect(options).toEqual({
      env: { PATH: '/usr/bin' },
      resourcesPath: '/Applications/Oat.app/Contents/Resources',
    });
    expect(env.OAT_AUDIO_BIN).toBe('/tmp/evil'); // the input isn't mutated
  });
});
