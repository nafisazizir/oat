/**
 * Oat desktop main process (task 1.8): hardened windows, the typed IPC bridge, the main-owned state store
 * and deep-link sign-in. See docs/tasks/1.8-desktop-shell.md (Design notes).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP_SCHEME, findDeepLinkArg } from '@oat/auth/desktop-link';
import type { SubscribeChannel, SubscribePayload } from '@oat/core/bridge';
import { InMemoryAudioRecordingStore } from '@oat/audio/node';
import { AudioIndex, SyncTransportError } from '@oat/local-store';
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  type WebContents,
} from 'electron';

import { ApiError, createApiClient } from './api-client.ts';
import { AuthController } from './auth.ts';
import { desktopConfigFromEnv } from './config.ts';
import { BridgeError, createBridge, type Logger, subscribePayload } from './ipc.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import { RecordingService, RecordingServiceError } from './recording-service.ts';
import { createRecordingSetup, InputError } from './recording-setup.ts';
import { mimeType, resolveRendererFile } from './renderer-files.ts';
import {
  APP_SCHEME,
  contentSecurityPolicy,
  isSafeExternalUrl,
  isTrustedFrame,
  navigationDecision,
  originOf,
  trustedOrigins,
} from './security.ts';
import { MainStore } from './store.ts';
import { SttCredentials } from './stt-credentials.ts';
import { SyncService } from './sync-service.ts';
import { TokenStore } from './token-store.ts';
import { createWindowFactory } from './windows.ts';

const log: Logger = {
  info: (message) => console.log(`[oat] ${message}`),
  warn: (message) => console.warn(`[oat] ${message}`),
  error: (message, error) => console.error(`[oat] ${message}`, error ?? ''),
};

// --- Configuration (before `ready`) ------------------------------------------------------------------

if (!app.isPackaged) {
  // Dev builds get their own name: their own userData folder and their own Keychain key ("Oat Dev Safe
  // Storage"), never the released app's.
  app.setName('Oat Dev');
  // The repo-root `.env` (DEV.md), without overriding variables already set.
  const rootEnv = join(app.getAppPath(), '..', '..', '.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}
const config = desktopConfigFromEnv(process.env, { isPackaged: app.isPackaged });
if (config.userDataDir) app.setPath('userData', config.userDataDir);

const origins = trustedOrigins(config.rendererDevUrl);
const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url));
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));

// A standard + secure scheme gives the built renderer a real origin (`app://oat`) for CSP and IPC checks.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

// Deep links can arrive before the app is ready (macOS `open-url` during launch): queue them.
const queuedLinks: string[] = [];
let deliverLink: ((url: string) => void) | null = null;
const onDeepLink = (url: string) => (deliverLink ? deliverLink(url) : queuedLinks.push(url));

// The single-instance lock lives in userData, so a test's temp profile doesn't collide with a dev app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    onDeepLink(url);
  });
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLinkArg(argv);
    if (link) onDeepLink(link);
    focusMainWindow();
  });
  const firstLink = findDeepLinkArg(process.argv); // Windows/Linux pass it on the command line
  if (firstLink) onDeepLink(firstLink);
  app.on('web-contents-created', (_event, contents) => harden(contents));
  void app.whenReady().then(start);
}

// --- Windows ---------------------------------------------------------------------------------------------

const windows = createWindowFactory({
  preloadPath,
  rendererDevUrl: config.rendererDevUrl,
  inactive: config.e2e,
  devTools: config.devTools,
});
let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;

function openMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = windows.main();
  mainWindow.on('closed', () => (mainWindow = null));
  return mainWindow;
}

function focusMainWindow() {
  const win = openMainWindow();
  if (win.isMinimized()) win.restore();
  if (!config.e2e) win.focus();
}

function openWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.showInactive();
    return;
  }
  widgetWindow = windows.widget();
  widgetWindow.on('closed', () => (widgetWindow = null));
}

/** No new windows, no navigation away from our origin, no webviews; http(s) links go to the browser. */
function harden(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const decision = navigationDecision(url, origins);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'open-external') void shell.openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (navigationDecision(url, origins) !== 'allow') event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Pushes to every window that shows our renderer (validated first). */
function broadcast<C extends SubscribeChannel>(channel: C, value: SubscribePayload<C>) {
  const payload = subscribePayload(channel, value);
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents;
    if (contents.isDestroyed() || !isTrustedFrame(contents.mainFrame, origins)) continue;
    contents.send(channel, payload);
  }
}

// --- Start -------------------------------------------------------------------------------------------------

async function start() {
  serveRenderer();
  // The renderer needs no device or browser permissions (audio capture is the sidecar's job).
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (config.rendererDevUrl) addDevServerCsp(config.rendererDevUrl);

  const store = new MainStore();
  const api = createApiClient({
    baseUrl: config.webUrl,
    ...(config.syncUrl ? { syncBaseUrl: config.syncUrl } : {}),
    userAgent: `Oat-Desktop/${app.getVersion()} (${process.platform})`,
    onSkippedChange: (reason) => log.warn(`sync: skipped a pulled change (${reason})`),
  });
  const tokens = new TokenStore({
    file: join(app.getPath('userData'), 'session.bin'),
    safeStorage,
    log,
  });
  const auth = new AuthController({
    webUrl: config.webUrl,
    api,
    tokens,
    store,
    log,
    openExternal: (url) => shell.openExternal(url),
  });

  let coldStartMs: number | null = null;
  const bridge = createBridge({
    ipcMain,
    isTrustedSender: (event) => isTrustedFrame(event.senderFrame, origins),
    log,
  });
  bridge.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dev: !!config.rendererDevUrl,
    packaged: app.isPackaged,
    coldStartMs,
  }));
  bridge.handle('state:get', () => store.snapshot());
  bridge.handle('auth:sign-in', () => {
    // D-28: no account switch while recording (the meeting belongs to the account that started it).
    if (auth.signedIn && recording.busy) {
      throw new BridgeError('invalid_state', 'Stop the recording before switching accounts.');
    }
    return auth.beginSignIn();
  });
  bridge.handle('auth:cancel-sign-in', () => auth.cancelSignIn());
  bridge.handle('auth:complete-from-link', async ({ url }) => {
    // Dev only: in a release, sign-in codes arrive by deep link, never by copy & paste (phishing).
    if (!config.allowDevHandoff) throw new BridgeError('forbidden', 'Not available.');
    return { accepted: await auth.handleDeepLink(url.trim()) };
  });
  bridge.handle('auth:sign-out', async () => {
    // Stop (and finish saving) a recording first: its transcription needs the session.
    if (recording.busy) await recording.shutdown();
    await auth.signOut();
  });
  bridge.handle('api:me', () => auth.me());
  bridge.handle('window:open-widget', () => {
    if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in first.');
    openWidgetWindow();
  });
  bridge.handle('window:close-widget', () => {
    widgetWindow?.close();
  });
  // --- Local databases + sync (2.6, D-19, D-28) ---
  // Audio rows: one never-wiped index for every account, next to the audio folder.
  let audioIndex: AudioIndex | InMemoryAudioRecordingStore;
  try {
    audioIndex = new AudioIndex({ path: join(app.getPath('userData'), 'audio-index.sqlite'), log });
  } catch (error) {
    log.error('audio index unavailable; audio rows of this session stay in memory', error);
    audioIndex = new InMemoryAudioRecordingStore();
  }
  const viaSession = <T>(fn: (token: string) => Promise<T>): Promise<T> =>
    auth.withSession(fn).catch((error: unknown) => {
      throw error instanceof ApiError ? new SyncTransportError(error.status, error.message) : error;
    });
  const sync: SyncService = new SyncService({
    dir: app.getPath('userData'),
    isRecording: (): boolean => recording.busy,
    onUnauthorized: () => void auth.me().catch(() => {}),
    transport: {
      push: (request) => viaSession((token) => api.syncPush(token, request)),
      pull: (cursor) => viaSession((token) => api.syncPull(token, cursor)),
    },
    onStatus: (status) => store.update((s) => ({ ...s, sync: status })),
    log,
  });
  bridge.handle('sync:now', () => sync.syncNow());
  const signedInUser = () =>
    store.state.auth.status === 'signed-in' ? store.state.auth.user.id : null;

  // --- Recording + live transcript (2.5) ---
  const credentials = new SttCredentials({ fetchGrant: () => auth.sttGrant() });
  const setup = createRecordingSetup({
    isPackaged: app.isPackaged,
    audio: config.audio,
    sttUrl: config.sttUrl,
    repoRoot: app.isPackaged ? undefined : join(app.getAppPath(), '..', '..'),
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    env: process.env,
    credentials,
    log,
  });
  const recording: RecordingService = new RecordingService({
    baseDir: app.getPath('userData'),
    store: audioIndex,
    persistence: new MeetingPersistence({ store: () => sync.store, sync, userId: signedInUser }),
    createSource: setup.createSource,
    createStt: setup.createStt,
    log,
    power: powerMonitor,
    onState: (snapshot) => broadcast('recording:state', snapshot),
    onSegments: (batch) => broadcast('transcript:segments', batch),
    onStatus: (status, meetingId) => {
      store.update((s) =>
        s.recording.status === status && s.activeMeetingId === meetingId
          ? s
          : { ...s, recording: { status }, activeMeetingId: meetingId },
      );
      if (status === 'idle') queueMicrotask(() => void sync.recordingEnded());
    },
  });
  stopRecordingOnQuit(recording);
  app.once('will-quit', () => {
    void sync.shutdown();
    if (audioIndex instanceof AudioIndex) audioIndex.close();
  });
  const recordingCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RecordingServiceError) {
        throw new BridgeError(
          error.code === 'invalid_state' ? 'invalid_state' : 'unavailable',
          error.message,
        );
      }
      if (error instanceof InputError) throw new BridgeError(error.code, error.message);
      throw error;
    }
  };
  bridge.handle('recording:options', () => ({
    defaultInput: config.audio.input,
    defaultFixture: config.audio.fixture,
    fixtures: setup.fixtures(),
  }));
  bridge.handle('recording:start', (request) =>
    recordingCall(() => {
      if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in to record.');
      const spec = setup.resolveInput(request);
      return recording.start({
        ...(request.meetingId ? { meetingId: request.meetingId } : {}),
        spec,
      });
    }),
  );
  bridge.handle('recording:pause', () => recordingCall(() => recording.pause()));
  bridge.handle('recording:resume', () => recordingCall(() => recording.resume()));
  bridge.handle('recording:stop', () => recordingCall(() => recording.stop()));
  bridge.handle('recording:get', () => recording.snapshot());
  bridge.handle('transcript:get', () => recording.transcript());

  bridge.on('app:rendered', ({ window }) => {
    if (window !== 'main' || coldStartMs !== null) return;
    coldStartMs = Math.round(process.uptime() * 1000);
    log.info(`cold start: ${coldStartMs} ms (process start → main window rendered)`);
  });
  bridge.on('shell:open-external', ({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });

  store.subscribe((snapshot) => {
    broadcast('state:changed', snapshot);
    if (snapshot.state.auth.status === 'signed-out') credentials.clear();
    // After this change has reached every listener (sync's own status updates go through the store).
    queueMicrotask(() => void sync.setUser(signedInUser()));
  });
  openMainWindow();
  await auth.restore();

  deliverLink = (url) => {
    void auth.handleDeepLink(url).then((signedIn) => {
      if (signedIn) focusMainWindow();
    });
  };
  for (const url of queuedLinks.splice(0)) deliverLink(url);

  registerProtocolClient();
  app.on('activate', () => openMainWindow());
}

/**
 * Quitting while recording (or while a stop / an ended session's files are still closing — `busy`) waits
 * for `shutdown()`: last transcript finals, closed audio files. Only then does the app quit, so a quit
 * never leaves a half-written recording behind. Recovery of crashed files is `recoverRecordings`.
 */
function stopRecordingOnQuit(recording: RecordingService) {
  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping || !recording.busy) return;
    event.preventDefault();
    stopping = true;
    log.info('quit: stopping the recording first');
    void recording.shutdown().finally(() => app.quit());
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/** `app://oat/<path>` → files of the built renderer, with the CSP header. */
function serveRenderer() {
  const csp = contentSecurityPolicy({ dev: false });
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveRendererFile(rendererDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': mimeType(file),
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Dev server responses get the (looser, HMR-friendly) dev CSP. */
function addDevServerCsp(devUrl: string) {
  const devOrigin = originOf(devUrl);
  const csp = contentSecurityPolicy({ dev: true });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (originOf(details.url) !== devOrigin) return callback({});
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
}

/**
 * `oat://` → this app. Packaged builds declare the scheme in Info.plist (9.1). In dev the Electron binary
 * is registered with this app's path as argument, and unregistered on quit so the OS isn't left pointing
 * at a dev checkout. e2e never registers (`OAT_E2E=1`); tests deliver links directly.
 */
function registerProtocolClient() {
  if (!config.registerProtocol) return;
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DESKTOP_SCHEME);
    return;
  }
  const args = [app.getAppPath()];
  const ok = app.setAsDefaultProtocolClient(DESKTOP_SCHEME, process.execPath, args);
  log.info(
    `dev: ${DESKTOP_SCHEME}:// handler ${ok ? 'registered' : 'not registered'} for this process`,
  );
  app.once('will-quit', () => {
    app.removeAsDefaultProtocolClient(DESKTOP_SCHEME, process.execPath, args);
  });
}
