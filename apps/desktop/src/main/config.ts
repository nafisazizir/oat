/**
 * Desktop configuration from the environment. Pure (no Electron imports) so it is unit-tested.
 *
 * A packaged app ignores environment overrides: nothing in the environment may point a released app at
 * another server (it would send the bearer token there), another sidecar binary or another data folder.
 */

/** Where apps/web runs when nothing else is configured (the `pnpm dev` / `pnpm dev:app` default). */
export const DEFAULT_WEB_URL = 'http://localhost:3000';

export interface DesktopConfig {
  /** Origin of apps/web: the sign-in page and the API. */
  webUrl: string;
  /** Overrides Electron's userData folder (tests use a temp dir per run). Dev only. */
  userDataDir: string | undefined;
  /** `OAT_E2E=1`: windows show without taking focus; `oat://` is not registered with the OS. Dev only. */
  e2e: boolean;
  /** Register `oat://` with the OS for this process (dev: the Electron binary + this app path). */
  registerProtocol: boolean;
  /** electron-vite dev server URL (`ELECTRON_RENDERER_URL`), when running `pnpm dev`. */
  rendererDevUrl: string | undefined;
  /** DevTools in renderer windows: dev server, or `OAT_DEVTOOLS=1` on a built renderer. Never packaged. */
  devTools: boolean;
  /** Dev-only affordances (pasting a sign-in link) are allowed. `false` when packaged. */
  allowDevHandoff: boolean;
  /** Default recording input (`OAT_AUDIO_SOURCE`, dev only; packaged: always the live sidecar). */
  audio: AudioInputConfig;
  /**
   * `OAT_STT_URL` (dev only): use this live-transcription websocket instead of the one the API names
   * (e2e points it at a dead port to test "transcription down, recording continues").
   */
  sttUrl: string | undefined;
  /**
   * `OAT_SYNC_URL` (dev only): send sync (`/api/sync/*`) to this origin instead of `webUrl` (e2e points it
   * at a port that is down, then up, to test offline → drain). Same rules as `OAT_WEB_URL`.
   */
  syncUrl: string | undefined;
}

export interface AudioInputConfig {
  input: 'sidecar' | 'file';
  /** `input: 'file'`: the fixture (`fixtures/audio/<name>.wav`). */
  fixture: string | null;
  /** Sidecar `--synthetic` tone generator: no devices, no permission prompts (dev only). */
  synthetic: boolean;
  /** FileSource fixtures may be used at all (never in a packaged app). */
  allowFixtures: boolean;
}

const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * `OAT_AUDIO_SOURCE`: unset / `sidecar` → live capture; `synthetic` → the sidecar's tone generator;
 * `file:<fixture>` → replay `fixtures/audio/<fixture>.wav` through FileSource (realtime).
 */
export function parseAudioSource(raw: string | undefined): AudioInputConfig {
  const value = raw?.trim() ?? '';
  const base = { allowFixtures: true };
  if (value === '' || value === 'sidecar') {
    return { ...base, input: 'sidecar', fixture: null, synthetic: false };
  }
  if (value === 'synthetic') return { ...base, input: 'sidecar', fixture: null, synthetic: true };
  const fixture = value.startsWith('file:') ? value.slice('file:'.length) : undefined;
  if (fixture !== undefined && FIXTURE_NAME.test(fixture)) {
    return { ...base, input: 'file', fixture, synthetic: false };
  }
  throw new DesktopConfigError(
    'OAT_AUDIO_SOURCE must be sidecar, synthetic or file:<fixture> (e.g. file:standup-short)',
  );
}

export class DesktopConfigError extends Error {
  override name = 'DesktopConfigError';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** http(s) origin; plain http only for loopback hosts. */
export function parseWebUrl(raw: string, name = 'OAT_WEB_URL'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DesktopConfigError(`${name} is not a URL`);
  }
  const httpOk = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !httpOk) {
    throw new DesktopConfigError(`${name} must be https (plain http only for localhost)`);
  }
  if (url.username || url.password)
    throw new DesktopConfigError(`${name} must not carry credentials`);
  return url.origin;
}

export function desktopConfigFromEnv(
  env: Record<string, string | undefined>,
  { isPackaged, bakedWebUrl = DEFAULT_WEB_URL }: { isPackaged: boolean; bakedWebUrl?: string },
): DesktopConfig {
  const blank = (v: string | undefined) =>
    v === undefined || v.trim() === '' ? undefined : v.trim();
  if (isPackaged) {
    return {
      webUrl: parseWebUrl(bakedWebUrl, 'the built-in web URL'),
      userDataDir: undefined,
      e2e: false,
      registerProtocol: true,
      rendererDevUrl: undefined,
      devTools: false,
      allowDevHandoff: false,
      audio: { input: 'sidecar', fixture: null, synthetic: false, allowFixtures: false },
      sttUrl: undefined,
      syncUrl: undefined,
    };
  }
  const e2e = env.OAT_E2E === '1';
  const webEnv = blank(env.OAT_WEB_URL) ? 'OAT_WEB_URL' : 'BETTER_AUTH_URL';
  return {
    webUrl: parseWebUrl(
      blank(env.OAT_WEB_URL) ?? blank(env.BETTER_AUTH_URL) ?? bakedWebUrl,
      webEnv,
    ),
    userDataDir: blank(env.OAT_USER_DATA_DIR),
    e2e,
    registerProtocol: !e2e && env.OAT_REGISTER_PROTOCOL !== '0',
    rendererDevUrl: blank(env.ELECTRON_RENDERER_URL),
    devTools: !!blank(env.ELECTRON_RENDERER_URL) || env.OAT_DEVTOOLS === '1',
    allowDevHandoff: true,
    audio: parseAudioSource(env.OAT_AUDIO_SOURCE),
    sttUrl: blank(env.OAT_STT_URL),
    syncUrl: blank(env.OAT_SYNC_URL) && parseWebUrl(blank(env.OAT_SYNC_URL)!, 'OAT_SYNC_URL'),
  };
}
