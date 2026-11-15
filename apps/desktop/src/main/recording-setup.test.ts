import { fileURLToPath } from 'node:url';

import { FileSource } from '@oat/audio';
import { DeepgramProvider } from '@oat/stt';
import { describe, expect, it, vi } from 'vitest';

import type { AudioInputConfig } from './config.ts';
import type { Logger } from './ipc.ts';
import { createRecordingSetup, DEEPGRAM_LISTEN_URL, InputError } from './recording-setup.ts';
import { SttCredentials } from './stt-credentials.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup({
  isPackaged = false,
  audio = { input: 'file', fixture: 'standup-short', synthetic: false, allowFixtures: true },
  sttUrl,
  listenUrl = async () => 'ws://localhost:14010/stt/v1/listen',
}: {
  isPackaged?: boolean;
  audio?: AudioInputConfig;
  sttUrl?: string;
  listenUrl?: () => Promise<string>;
} = {}) {
  const credentials = new SttCredentials({
    fetchGrant: async () => ({ accessToken: 't', expiresIn: 60, listenUrl: await listenUrl() }),
  });
  return createRecordingSetup({
    isPackaged,
    audio,
    sttUrl,
    repoRoot: isPackaged ? undefined : REPO,
    resourcesPath: undefined,
    env: {},
    credentials,
    log,
  });
}

describe('createRecordingSetup', () => {
  it('dev: lists the repo fixtures and resolves the default input', () => {
    const s = setup();
    expect(s.fixtures()).toEqual(expect.arrayContaining(['one-on-one', 'standup-short']));
    expect(s.resolveInput({})).toEqual({ input: 'file', fixture: 'standup-short' });
    expect(s.resolveInput({ input: 'sidecar' })).toEqual({ input: 'sidecar' });
    expect(s.resolveInput({ input: 'file', fixture: 'one-on-one' })).toEqual({
      input: 'file',
      fixture: 'one-on-one',
    });
    expect(() => s.resolveInput({ input: 'file', fixture: 'nope' })).toThrow(InputError);
    expect(s.createSource({ input: 'file', fixture: 'one-on-one' })).toBeInstanceOf(FileSource);
  });

  it('packaged: no fixtures, file input refused', () => {
    const s = setup({
      isPackaged: true,
      audio: { input: 'sidecar', fixture: null, synthetic: false, allowFixtures: false },
    });
    expect(s.fixtures()).toEqual([]);
    expect(() => s.resolveInput({ input: 'file', fixture: 'standup-short' })).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(() => s.createSource({ input: 'file', fixture: 'standup-short' })).toThrow();
  });

  it('STT: the endpoint the API names; mock fixture params only for a local mock', async () => {
    const s = setup();
    const provider = await s.createStt({
      meetingId: 'm',
      spec: { input: 'file', fixture: 'standup-short' },
    });
    expect(provider).toBeInstanceOf(DeepgramProvider);
  });

  it('STT: falls back to the default endpoint when the API is unreachable', async () => {
    const s = setup({
      isPackaged: true,
      audio: { input: 'sidecar', fixture: null, synthetic: false, allowFixtures: false },
      listenUrl: () => Promise.reject(new Error('offline')),
    });
    await s.createStt({ meetingId: 'm', spec: { input: 'sidecar' } });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('using the default'));
    expect(DEEPGRAM_LISTEN_URL).toBe('wss://api.deepgram.com/v1/listen');
  });
});
