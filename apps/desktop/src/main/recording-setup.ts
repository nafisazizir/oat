/**
 * Builds the app's `RecordingService` from config (2.5): which audio source, which STT endpoint and
 * credentials. Kept apart from `index.ts` so the choices are unit-tested without Electron.
 *
 * - Audio: the Swift sidecar (`SidecarSource`, restarted on crash) or, in dev builds only, a WAV fixture
 *   replayed in real time (`FileSource`, `OAT_AUDIO_SOURCE=file:<name>`; the e2e default). `synthetic`
 *   runs the sidecar's tone generator (no devices, no prompts).
 * - STT: `DeepgramProvider` per source with short-lived tokens from our API (D-17). The websocket URL is
 *   the one the API names for its token (mock in dev, Deepgram in prod); `OAT_STT_URL` overrides it in
 *   dev builds. If the API can't be reached at start, the provider uses the default URL and keeps asking
 *   for a token on every reconnect, so transcription catches up once it is back (replay buffer).
 * - Fixture replays against a local mock add the mock's `mock_fixture` parameters so the transcript is
 *   the fixture's ground truth (dev/e2e only: never packaged, never a remote endpoint).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type AudioSource, FileSource, locateSidecarBinary, SidecarSource } from '@oat/audio/node';
import { DeepgramProvider, resolveDeepgramEndpoints, type SttProvider } from '@oat/stt';

import type { AudioInputConfig } from './config.ts';
import type { Logger } from './ipc.ts';
import { type InputSpec, type SttContext } from './recording-service.ts';
import { sidecarLocateOptions } from './sidecar.ts';
import type { SttCredentials } from './stt-credentials.ts';

export const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
const FIXTURE_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.wav$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** How long a start waits for the API to name the STT endpoint before using the default. */
const LISTEN_URL_TIMEOUT_MS = 4_000;

export interface RecordingSetupOptions {
  isPackaged: boolean;
  audio: AudioInputConfig;
  /** `OAT_STT_URL` (dev only). */
  sttUrl: string | undefined;
  /** Repo checkout (dev): fixtures and the dev sidecar build live here. */
  repoRoot: string | undefined;
  resourcesPath: string | undefined;
  env: NodeJS.ProcessEnv;
  credentials: SttCredentials;
  log: Logger;
}

export function createRecordingSetup(o: RecordingSetupOptions) {
  const fixturesDir =
    o.audio.allowFixtures && o.repoRoot ? join(o.repoRoot, 'fixtures', 'audio') : undefined;

  function fixtures(): string[] {
    if (!fixturesDir) return [];
    try {
      return readdirSync(fixturesDir)
        .map((f) => FIXTURE_FILE.exec(f)?.[1])
        .filter((f): f is string => !!f)
        .sort();
    } catch {
      return [];
    }
  }

  function sidecarBinary(): string {
    const located = locateSidecarBinary(
      sidecarLocateOptions({
        isPackaged: o.isPackaged,
        env: o.env,
        ...(o.resourcesPath ? { resourcesPath: o.resourcesPath } : {}),
      }),
    );
    // `@oat/audio`'s own dev path is relative to its source file, which bundling moves: look in the repo.
    const dev =
      o.repoRoot && join(o.repoRoot, 'native', 'oat-audio', '.build', 'release', 'oat-audio');
    const binary = located ?? (dev && existsSync(dev) ? dev : undefined);
    if (!binary) throw new Error('oat-audio binary not found');
    return binary;
  }

  /** Resolves the user's request (or the configured default) to a source spec. */
  function resolveInput(request: { input?: 'sidecar' | 'file'; fixture?: string }): InputSpec {
    const input = request.input ?? o.audio.input;
    if (input === 'sidecar') return { input: 'sidecar' };
    if (!fixturesDir)
      throw new InputError('forbidden', 'Fixture replay is only available in development builds.');
    const fixture = request.fixture ?? o.audio.fixture ?? fixtures()[0];
    if (!fixture || !fixtures().includes(fixture)) {
      throw new InputError('invalid_payload', `Unknown fixture ${fixture ?? '(none)'}.`);
    }
    return { input: 'file', fixture };
  }

  function createSource(spec: InputSpec): AudioSource {
    if (spec.input === 'file') {
      if (!fixturesDir) throw new Error('fixtures are disabled');
      return new FileSource({
        input: { stereo: join(fixturesDir, `${spec.fixture}.wav`) },
        speed: 'realtime',
      });
    }
    return new SidecarSource({
      binary: sidecarBinary(),
      restart: true,
      synthetic: o.audio.synthetic,
      onStderr: (line) => o.log.info(`oat-audio: ${line}`),
    });
  }

  async function listenUrl(): Promise<string> {
    if (o.sttUrl && !o.isPackaged) return o.sttUrl;
    try {
      return await withTimeout(o.credentials.listenUrl(), LISTEN_URL_TIMEOUT_MS);
    } catch (error) {
      o.log.warn(`recording: STT endpoint unknown (${String(error)}); using the default`);
      return o.isPackaged ? DEEPGRAM_LISTEN_URL : resolveDeepgramEndpoints(o.env).listenUrl;
    }
  }

  async function createStt({ spec }: SttContext): Promise<SttProvider> {
    const url = await listenUrl();
    const fixture = spec.input === 'file' ? spec.fixture : undefined;
    const mockFixture = fixture && !o.isPackaged && LOOPBACK.has(new URL(url).hostname);
    return new DeepgramProvider({
      url,
      getToken: o.credentials.getToken,
      // A stop waits at most this long for the last finals.
      finishTimeoutMs: 8_000,
      ...(mockFixture
        ? {
            extraQuery: ({ source, offsetMs }) => ({
              mock_fixture: fixture,
              mock_channel: source,
              mock_offset_ms: Math.round(offsetMs ?? 0),
            }),
          }
        : {}),
    });
  }

  return { fixtures, resolveInput, createSource, createStt };
}

/** A start request that can't be served; `code` is a bridge error code. */
export class InputError extends Error {
  override name = 'InputError';
  constructor(
    readonly code: 'forbidden' | 'invalid_payload',
    message: string,
  ) {
    super(message);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}
