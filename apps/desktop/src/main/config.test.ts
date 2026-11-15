import { describe, expect, it } from 'vitest';

import { DEFAULT_WEB_URL, desktopConfigFromEnv, parseAudioSource, parseWebUrl } from './config.ts';

describe('desktopConfigFromEnv', () => {
  it('dev: OAT_WEB_URL, else BETTER_AUTH_URL, else the default', () => {
    const dev = { isPackaged: false };
    expect(desktopConfigFromEnv({}, dev).webUrl).toBe(DEFAULT_WEB_URL);
    expect(desktopConfigFromEnv({ BETTER_AUTH_URL: 'http://localhost:3001' }, dev).webUrl).toBe(
      'http://localhost:3001',
    );
    expect(
      desktopConfigFromEnv(
        { OAT_WEB_URL: 'http://127.0.0.1:4000/x', BETTER_AUTH_URL: 'http://localhost:3001' },
        dev,
      ).webUrl,
    ).toBe('http://127.0.0.1:4000');
  });

  it('dev: e2e mode never registers the protocol', () => {
    const c = desktopConfigFromEnv(
      { OAT_E2E: '1', OAT_USER_DATA_DIR: '/tmp/x', ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      { isPackaged: false },
    );
    expect(c).toMatchObject({
      e2e: true,
      registerProtocol: false,
      userDataDir: '/tmp/x',
      rendererDevUrl: 'http://localhost:5173',
    });
    expect(desktopConfigFromEnv({}, { isPackaged: false }).registerProtocol).toBe(true);
    expect(
      desktopConfigFromEnv({ OAT_REGISTER_PROTOCOL: '0' }, { isPackaged: false }).registerProtocol,
    ).toBe(false);
  });

  it('packaged: the environment cannot redirect the app', () => {
    const c = desktopConfigFromEnv(
      {
        OAT_WEB_URL: 'https://evil.example',
        OAT_USER_DATA_DIR: '/tmp/x',
        OAT_E2E: '1',
        OAT_DEVTOOLS: '1',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
      },
      { isPackaged: true, bakedWebUrl: 'https://oat.example' },
    );
    expect(c).toEqual({
      webUrl: 'https://oat.example',
      userDataDir: undefined,
      e2e: false,
      registerProtocol: true,
      rendererDevUrl: undefined,
      devTools: false,
      allowDevHandoff: false,
      audio: { input: 'sidecar', fixture: null, synthetic: false, allowFixtures: false },
      sttUrl: undefined,
      syncUrl: undefined,
    });
  });

  it('OAT_SYNC_URL: dev only, same rules as OAT_WEB_URL', () => {
    expect(desktopConfigFromEnv({}, { isPackaged: false }).syncUrl).toBeUndefined();
    expect(
      desktopConfigFromEnv({ OAT_SYNC_URL: 'http://127.0.0.1:9/x' }, { isPackaged: false }).syncUrl,
    ).toBe('http://127.0.0.1:9');
    expect(() =>
      desktopConfigFromEnv({ OAT_SYNC_URL: 'http://evil.example' }, { isPackaged: false }),
    ).toThrow(/OAT_SYNC_URL/);
    expect(
      desktopConfigFromEnv({ OAT_SYNC_URL: 'https://evil.example' }, { isPackaged: true }).syncUrl,
    ).toBeUndefined();
  });

  it('packaged: OAT_AUDIO_SOURCE / OAT_STT_URL are ignored (live capture, API-chosen STT)', () => {
    const c = desktopConfigFromEnv(
      { OAT_AUDIO_SOURCE: 'file:standup-short', OAT_STT_URL: 'ws://localhost:1/x' },
      { isPackaged: true },
    );
    expect(c.audio).toEqual({
      input: 'sidecar',
      fixture: null,
      synthetic: false,
      allowFixtures: false,
    });
    expect(c.sttUrl).toBeUndefined();
  });

  it('dev: OAT_AUDIO_SOURCE picks the default input; OAT_STT_URL overrides the STT socket', () => {
    const dev = { isPackaged: false };
    expect(desktopConfigFromEnv({}, dev).audio).toMatchObject({
      input: 'sidecar',
      synthetic: false,
    });
    expect(
      desktopConfigFromEnv({ OAT_AUDIO_SOURCE: 'file:standup-short', OAT_STT_URL: 'ws://x' }, dev),
    ).toMatchObject({
      audio: { input: 'file', fixture: 'standup-short', allowFixtures: true },
      sttUrl: 'ws://x',
    });
  });
});

describe('parseAudioSource', () => {
  it('accepts sidecar, synthetic and file:<fixture>', () => {
    expect(parseAudioSource(undefined)).toMatchObject({ input: 'sidecar', synthetic: false });
    expect(parseAudioSource(' sidecar ')).toMatchObject({ input: 'sidecar', synthetic: false });
    expect(parseAudioSource('synthetic')).toMatchObject({ input: 'sidecar', synthetic: true });
    expect(parseAudioSource('file:one-on-one')).toMatchObject({
      input: 'file',
      fixture: 'one-on-one',
    });
  });

  it('refuses anything else (no paths, no traversal)', () => {
    for (const bad of ['mic', 'file:', 'file:../etc/passwd', 'file:/tmp/a.wav', 'file:A B']) {
      expect(() => parseAudioSource(bad), bad).toThrow(/OAT_AUDIO_SOURCE/);
    }
  });

  it('DevTools: dev server or OAT_DEVTOOLS=1 when unpackaged, never when packaged', () => {
    const dev = { isPackaged: false };
    expect(desktopConfigFromEnv({}, dev).devTools).toBe(false);
    expect(desktopConfigFromEnv({ OAT_DEVTOOLS: '1' }, dev).devTools).toBe(true);
    expect(
      desktopConfigFromEnv({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, dev).devTools,
    ).toBe(true);
    expect(desktopConfigFromEnv({ OAT_DEVTOOLS: '1' }, { isPackaged: true }).devTools).toBe(false);
  });
});

describe('parseWebUrl', () => {
  it('needs https except on loopback, and no credentials', () => {
    expect(parseWebUrl('https://oat.example/path')).toBe('https://oat.example');
    expect(parseWebUrl('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(() => parseWebUrl('http://oat.example')).toThrow(/https/);
    expect(() => parseWebUrl('ftp://localhost')).toThrow(/https/);
    expect(() => parseWebUrl('https://u:p@oat.example')).toThrow(/credentials/);
    expect(() => parseWebUrl('nope')).toThrow(/not a URL/);
  });
});
