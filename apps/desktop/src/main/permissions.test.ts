import { describe, expect, it } from 'vitest';

import {
  canRequest,
  FixturePermissions,
  parsePermissionsJson,
  PRIVACY_URLS,
  SidecarPermissions,
  UNKNOWN_PERMISSIONS,
} from './permissions.ts';

describe('parsePermissionsJson (oat-audio permissions)', () => {
  it('reads the sidecar’s answer', () => {
    expect(
      parsePermissionsJson(
        '{"microphone":"granted","system_audio":"not_determined","system_audio_method":"tcc_preflight","system_audio_supported":true,"os_version":"15.1.0","prompted":false}\n',
      ),
    ).toEqual({ microphone: 'granted', systemAudio: 'not_determined', systemAudioSupported: true });
  });

  it('treats words it doesn’t know as unknown, and keeps the last line', () => {
    expect(parsePermissionsJson('noise\n{"microphone":"limited","system_audio":"denied"}')).toEqual(
      { microphone: 'unknown', systemAudio: 'denied', systemAudioSupported: true },
    );
  });

  it('rejects garbage', () => {
    expect(() => parsePermissionsJson('not json')).toThrow();
  });
});

describe('canRequest', () => {
  it('only asks macOS what it never asked (a denial is changed in System Settings)', () => {
    expect(canRequest('not_determined')).toBe(true);
    expect(canRequest('unknown')).toBe(true);
    expect(canRequest('granted')).toBe(false);
    expect(canRequest('denied')).toBe(false);
    expect(canRequest('restricted')).toBe(false);
  });
});

describe('FixturePermissions', () => {
  it('answers a request in memory (granted by default)', async () => {
    const p = new FixturePermissions({});
    expect(await p.status()).toEqual({
      microphone: 'not_determined',
      systemAudio: 'not_determined',
      systemAudioSupported: true,
    });
    await p.request('microphone');
    expect((await p.status()).microphone).toBe('granted');
    expect(p.requests).toEqual(['microphone']);
  });

  it('a configured answer can deny; a denial is never asked again', async () => {
    const p = new FixturePermissions({ answers: { system_audio: 'denied' } });
    await p.request('system_audio');
    expect((await p.status()).systemAudio).toBe('denied');
    const q = new FixturePermissions({ microphone: 'denied' });
    await q.request('microphone');
    expect((await q.status()).microphone).toBe('denied');
  });

  it('rejects unknown states', () => {
    expect(() => new FixturePermissions({ microphone: 'yes' })).toThrow();
  });
});

describe('SidecarPermissions', () => {
  const log = { warn: () => {} };

  it('without a sidecar every state is unknown and nothing prompts', async () => {
    let asked = 0;
    const p = new SidecarPermissions({
      binary: () => undefined,
      askForMicrophone: () => Promise.resolve(!!++asked),
      log,
    });
    expect(await p.status()).toEqual(UNKNOWN_PERMISSIONS);
    await p.request('system_audio'); // no binary: nothing to run
    expect(asked).toBe(0);
    await p.request('microphone'); // the user clicked "Allow": Electron's own request
    expect(asked).toBe(1);
  });

  it('a binary that fails to answer reads as unknown', async () => {
    const p = new SidecarPermissions({
      binary: () => '/nonexistent/oat-audio',
      askForMicrophone: () => Promise.resolve(true),
      log,
    });
    expect(await p.status()).toEqual(UNKNOWN_PERMISSIONS);
  });
});

describe('PRIVACY_URLS', () => {
  it('are System Settings deep links (opened with shell.openExternal)', () => {
    for (const url of Object.values(PRIVACY_URLS)) {
      expect(url).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
    }
  });
});
