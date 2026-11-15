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
  /** Where the Mac's calendar events come from (7.3). */
  calendar: CalendarConfig;
  /** Meeting detection's mic-apps signal (7.3, D-21). */
  detection: DetectionConfig;
  /**
   * Auto-stop timings (7.5): `OAT_AUTO_STOP` (dev only), a JSON object of `@oat/detection` `AutoStopConfig`
   * fields (`floorMs`, `confirmMs`, `undoMs`, `silenceMs`, `silenceDb`, `speechDb`, `eventEndWindowMs`):
   * e2e can't wait minutes.
   */
  autoStop: AutoStopTimings;
  /** `OAT_END_GRACE_MS` (dev only): the grace period after a stop (default 60 s). */
  endGraceMs: number | undefined;
}

export interface AutoStopTimings {
  floorMs?: number;
  confirmMs?: number;
  speechDb?: number;
  undoMs?: number;
  silenceMs?: number;
  silenceDb?: number;
  eventEndWindowMs?: number;
}

const TIMING_KEYS = [
  'floorMs',
  'confirmMs',
  'undoMs',
  'silenceMs',
  'silenceDb',
  'speechDb',
  'eventEndWindowMs',
] as const;

export function parseAutoStopTimings(raw: string | undefined): AutoStopTimings {
  const value = raw?.trim() ?? '';
  if (value === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new DesktopConfigError('OAT_AUTO_STOP must be a JSON object');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new DesktopConfigError('OAT_AUTO_STOP must be a JSON object');
  }
  const out: AutoStopTimings = {};
  for (const [key, v] of Object.entries(json)) {
    const k = TIMING_KEYS.find((t) => t === key);
    const ok =
      typeof v === 'number' &&
      Number.isFinite(v) &&
      (k === 'silenceDb' || k === 'speechDb' || v >= 0);
    if (!k || !ok) throw new DesktopConfigError(`OAT_AUTO_STOP: bad ${key}`);
    out[k] = v as number;
  }
  return out;
}

function parseGraceMs(raw: string | undefined): number | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new DesktopConfigError('OAT_END_GRACE_MS must be a non-negative integer (ms)');
  }
  return n;
}

/**
 * `OAT_CALENDAR` (dev only): unset / `off` → no Mac calendar (Google through the web API still works);
 * `eventkit` → the real calendars through the sidecar (never prompts by itself; access is a human
 * checkpoint); `fixture:<file>` → normalised events from a JSON (array) or JSON-lines file, in process.
 * Packaged: always `eventkit`.
 */
export type CalendarConfig =
  { kind: 'off' } | { kind: 'eventkit' } | { kind: 'fixture'; file: string };

/**
 * `OAT_DETECTION` (dev only): unset / `off` → no detection; `sidecar` → `oat-audio mic-apps watch` (Core Audio
 * metadata, no capture; its first real run is a human checkpoint); `fixture:<file>` → replay a detection
 * timeline's `steps[].micApps` (`fixtures/detection/*.json` format) in process, from when detection starts;
 * `file:<apps.json>` → the mic-using processes are whatever that JSON array says, re-read when it changes (e2e
 * drives calls ending and coming back with it, 7.5). Packaged: always `sidecar`.
 */
export type DetectionConfig =
  | { kind: 'off' }
  | { kind: 'sidecar' }
  | { kind: 'fixture'; file: string }
  | { kind: 'file'; file: string };

export function parseCalendarSource(raw: string | undefined): CalendarConfig {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'off') return { kind: 'off' };
  if (value === 'eventkit') return { kind: 'eventkit' };
  if (value.startsWith('fixture:') && value.length > 'fixture:'.length) {
    return { kind: 'fixture', file: value.slice('fixture:'.length) };
  }
  throw new DesktopConfigError('OAT_CALENDAR must be off, eventkit or fixture:<file>');
}

export function parseDetectionSource(raw: string | undefined): DetectionConfig {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'off') return { kind: 'off' };
  if (value === 'sidecar') return { kind: 'sidecar' };
  if (value.startsWith('fixture:') && value.length > 'fixture:'.length) {
    return { kind: 'fixture', file: value.slice('fixture:'.length) };
  }
  if (value.startsWith('file:') && value.length > 'file:'.length) {
    return { kind: 'file', file: value.slice('file:'.length) };
  }
  throw new DesktopConfigError(
    'OAT_DETECTION must be off, sidecar, fixture:<timeline.json> or file:<apps.json>',
  );
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
      calendar: { kind: 'eventkit' },
      detection: { kind: 'sidecar' },
      autoStop: {},
      endGraceMs: undefined,
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
    calendar: parseCalendarSource(env.OAT_CALENDAR),
    detection: parseDetectionSource(env.OAT_DETECTION),
    autoStop: parseAutoStopTimings(env.OAT_AUTO_STOP),
    endGraceMs: parseGraceMs(env.OAT_END_GRACE_MS),
  };
}
