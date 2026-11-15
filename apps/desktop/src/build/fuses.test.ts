import { FuseV1Options } from '@electron/fuses';
import { describe, expect, it } from 'vitest';

import { OAT_FUSES } from './fuses.ts';

describe('OAT_FUSES', () => {
  it('hardens the packaged binary', () => {
    expect(OAT_FUSES[FuseV1Options.RunAsNode]).toBe(false);
    expect(OAT_FUSES[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(OAT_FUSES[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(OAT_FUSES[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(OAT_FUSES[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(OAT_FUSES[FuseV1Options.EnableCookieEncryption]).toBe(true);
    expect(OAT_FUSES[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
  });

  it('decides every fuse this Electron version has', () => {
    expect(OAT_FUSES.strictlyRequireAllFuses).toBe(true);
    const fuses = Object.values(FuseV1Options).filter((v) => typeof v === 'number');
    for (const fuse of fuses) expect(typeof OAT_FUSES[fuse as FuseV1Options]).toBe('boolean');
  });
});
