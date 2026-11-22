/**
 * Oat desktop main process (task 1.8): hardened windows, the typed IPC bridge, the main-owned state store
 * and deep-link sign-in. See docs/tasks/1.8-desktop-shell.md (Design notes).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP_SCHEME, findDeepLinkArg } from '@oat/auth/desktop-link';
import {
  type PermissionsSnapshot,
  PLAYBACK_SCHEME,
  type SubscribeChannel,
  type SubscribePayload,
} from '@oat/core/bridge';
import { InMemoryAudioRecordingStore } from '@oat/audio/node';
import {
  AudioIndex,
  InMemoryTranscriptJobStore,
  SyncTransportError,
  type TranscriptJobStore,
} from '@oat/local-store';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  type WebContents,
} from 'electron';

import { ApiError, createApiClient, createApiRequester } from './api-client.ts';
import { registerApiProxy } from './api-proxy.ts';
import { createSettingsIo } from './settings-io.ts';
import { AudioPlayback, PlaybackError } from './audio-playback.ts';
import { AudioStorage, StorageError } from './audio-storage.ts';
import { AuthController } from './auth.ts';
import { AutoStopService, AutoStopServiceError } from './auto-stop-service.ts';
import { CalendarService } from './calendar-service.ts';
import { createCalendarSetup } from './calendar-setup.ts';
import { desktopConfigFromEnv } from './config.ts';
import {
  DetectionService,
  DetectionServiceError,
  type NotifyRequest,
  type ShownNotification,
} from './detection-service.ts';
import { BridgeError, createBridge, type Logger, subscribePayload } from './ipc.ts';
import { MeetingEndGrace } from './meeting-end-grace.ts';
import { MeetingNotes, MeetingNotesError } from './meeting-notes.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import { Workspaces, WorkspacesError } from './workspaces.ts';
import { NotesFlush } from './notes-flush.ts';
import { OnboardingStore } from './onboarding-store.ts';
import {
  canRequest,
  FixturePermissions,
  type PermissionSource,
  PRIVACY_URLS,
  SidecarPermissions,
} from './permissions.ts';
import { RecordingService, RecordingServiceError } from './recording-service.ts';
import { recoverCrashedRecordings } from './recording-recovery.ts';
import { createRecordingSetup, InputError } from './recording-setup.ts';
import { mimeType, resolveRendererFile } from './renderer-files.ts';
import {
  APP_SCHEME,
  contentSecurityPolicy,
  externalDocumentUrl,
  isSafeExternalUrl,
  isTrustedFrame,
  navigationDecision,
  originOf,
  trustedOrigins,
} from './security.ts';
import { MainStore } from './store.ts';
import { SttCredentials } from './stt-credentials.ts';
import { deviceName, SyncService } from './sync-service.ts';
import { TokenStore } from './token-store.ts';
import { TestRecording, TestRecordingError } from './test-recording.ts';
import { TranscriptBackfill } from './transcript-backfill.ts';
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
  // Meeting audio for the player (3.7): `stream` lets the media element seek with range requests.
  { scheme: PLAYBACK_SCHEME, privileges: { standard: true, secure: true, stream: true } },
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
  const settingsIo = createSettingsIo({
    baseUrl: config.webUrl,
    withSession: (run) => auth.withSession(run),
    request: createApiRequester({ baseUrl: config.webUrl }),
    chooseZip: async () => {
      const result = await dialog.showSaveDialog({
        title: 'Export my notes',
        defaultPath: 'oat-notes.zip',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    openExternal: (url) => shell.openExternal(url),
  });
  bridge.handle('settings:export-notes', settingsIo.exportNotes);
  bridge.handle('settings:connect', settingsIo.connect);
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
    await testRecording.stop(); // 9.2: nothing to save, but it uses this account's transcription
    grace.flush(); // 7.5: a meeting in its grace period ends now, in this account's database
    apiProxy.cancelAll();
    await auth.signOut();
  });
  bridge.handle('api:me', () => auth.me());
  const apiProxy = registerApiProxy({
    bridge,
    baseUrl: config.webUrl,
    auth,
    store,
    request: createApiRequester({
      baseUrl: config.webUrl,
      userAgent: `Oat-Desktop/${app.getVersion()} (${process.platform})`,
    }),
  });
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
  // 2.7: transcript back-fill jobs + crash recoveries live in the same never-wiped index.
  const transcriptJobs: TranscriptJobStore =
    audioIndex instanceof AudioIndex ? audioIndex : new InMemoryTranscriptJobStore();
  // Crash recovery (2.7): repair files of sessions the app never finished, before any recording starts.
  const recovered = recoverCrashedRecordings({
    audio: audioIndex,
    jobs: transcriptJobs,
    log,
  }).catch((error: unknown) => {
    log.error('recovery: could not repair crashed recordings', error);
    return [];
  });
  const viaSession = <T>(fn: (token: string) => Promise<T>): Promise<T> =>
    auth.withSession(fn).catch((error: unknown) => {
      throw error instanceof ApiError ? new SyncTransportError(error.status, error.message) : error;
    });
  // 3.4: windows reload their meeting notes when these change (local writes, pulled changes).
  let meetingsSeq = 0;
  let meetingsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tells the windows to reload their meeting notes (coalesced: at most every 250 ms). */
  function meetingsChanged() {
    if (meetingsTimer) return;
    meetingsTimer = setTimeout(() => {
      meetingsTimer = undefined;
      broadcast('meetings:changed', { seq: ++meetingsSeq });
      calendar.notesChanged(); // 7.3: "Upcoming" marks events that have a note
    }, 250);
  }
  const sync: SyncService = new SyncService({
    dir: app.getPath('userData'),
    isRecording: (): boolean => recording.busy,
    onUnauthorized: () => void auth.me().catch(() => {}),
    transport: {
      push: (request) => viaSession((token) => api.syncPush(token, request)),
      pull: (cursor) => viaSession((token) => api.syncPull(token, cursor)),
      backfill: (documentId, after) =>
        viaSession((token) => api.syncBackfill(token, documentId, after)),
    },
    // 3.5: SSE invalidation channel (pull on every event; 60 s backstop) and this Mac's name.
    events: {
      connect: (lastEventId, signal) =>
        auth.withSession((token) => api.openSyncEvents(token, lastEventId, signal)),
    },
    deviceName: deviceName(),
    onStatus: (status) => {
      // 3.4: a finished sync run may have pulled changes to the notes on screen.
      if (status.lastSyncedAt !== store.state.sync.lastSyncedAt) meetingsChanged();
      store.update((s) => ({ ...s, sync: status }));
    },
    log,
  });
  bridge.handle('sync:now', () => sync.syncNow());
  bridge.handle('search:query', ({ query }) => ({ hits: sync.search(query) }));
  bridge.handle('conflicts:list', () => ({ conflicts: sync.conflicts() }));
  bridge.handle('conflicts:get', ({ copyId }) => sync.conflict(copyId));
  bridge.handle('conflicts:resolve', ({ copyId, keep }) => ({
    resolved: sync.resolveConflict(copyId, keep),
  }));
  const signedInUser = () =>
    store.state.auth.status === 'signed-in' ? store.state.auth.user.id : null;

  // --- Workspaces (3.9): the sidebar's switcher and where new notes go ---
  const workspaces = new Workspaces({
    store: () => sync.store,
    userId: signedInUser,
    sync,
    onChange: meetingsChanged,
  });
  bridge.handle('workspaces:list', () => workspaces.snapshot());
  bridge.handle('workspaces:set-active', ({ workspaceId }) => {
    try {
      return workspaces.setActive(workspaceId);
    } catch (error) {
      if (error instanceof WorkspacesError) throw new BridgeError('invalid_state', error.message);
      throw error;
    }
  });
  const newNoteWorkspace = (timeoutMs?: number) => workspaces.newNoteWorkspace(timeoutMs);

  // --- Meeting notes (3.4) ---
  const notes = new MeetingNotes({
    store: () => sync.store,
    userId: signedInUser,
    sync,
    newNoteWorkspace,
    onChange: meetingsChanged,
    // D-24: a meeting can be continued only where its audio parts are.
    hasAudio: async (meetingId) =>
      (await audioIndex.list({ meetingId })).some((r) => r.status !== 'deleted'),
    calendarEvent: (key) => calendar.findByKey(key),
  });
  const notesCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MeetingNotesError) {
        throw new BridgeError(
          error.code === 'unavailable' ? 'unavailable' : 'invalid_state',
          error.message,
        );
      }
      throw error;
    }
  };
  bridge.handle('meetings:list', () => ({ notes: notes.list() }));
  bridge.handle('meeting:get', (by) => notes.get(by));
  bridge.handle('meeting:transcript', ({ documentId }) =>
    notesCall(() => ({ segments: notes.transcript(documentId) })),
  );
  bridge.handle('meeting:save', ({ documentId, base, ...patch }) =>
    notesCall(() => notes.save(documentId, base, patch)),
  );
  // Quit writes what the main window still has pending (≤ 1 s, see `quitGracefully`).
  const notesFlush = new NotesFlush({
    send: (id) => {
      const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
      if (!contents || contents.isDestroyed()) return false;
      contents.send('notes:flush', subscribePayload('notes:flush', { id }));
      return true;
    },
  });
  bridge.on('notes:flushed', ({ id }) => notesFlush.ack(id));
  bridge.handle('meeting:add-participant', ({ documentId, name, email }) =>
    notesCall(() => notes.addParticipant(documentId, { name, email })),
  );
  bridge.handle('meeting:remove-participant', ({ documentId, participantId }) =>
    notesCall(() => notes.removeParticipant(documentId, participantId)),
  );

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
  // 7.5: a stopped meeting's end (which starts the post-meeting pipeline once synced) waits for a grace period,
  // so "Continue recording" meanwhile never starts a run.
  const grace: MeetingEndGrace = new MeetingEndGrace({
    inner: new MeetingPersistence({
      store: () => sync.store,
      sync,
      userId: signedInUser,
      newNoteWorkspace,
      onChange: meetingsChanged,
    }),
    ...(config.endGraceMs !== undefined ? { graceMs: config.endGraceMs } : {}),
    userId: () => sync.storeUser,
    // Survives a crash inside the period: ended at the next launch, once that account's database is open.
    file: join(app.getPath('userData'), 'grace-pending.json'),
    onChange: (pending) =>
      broadcast('grace:changed', {
        grace: pending && {
          meetingId: pending.meetingId,
          endedAt: pending.endedAt,
          dueAt: pending.dueAt,
        },
      }),
    log,
  });
  const recording: RecordingService = new RecordingService({
    baseDir: app.getPath('userData'),
    // 2.7: every start path (UI, detection, calendar, auto-start) waits for crash recovery first.
    ready: recovered,
    store: audioIndex,
    // D-30: audio rows name the account that recorded them.
    userId: signedInUser,
    persistence: grace,
    createSource: setup.createSource,
    createStt: setup.createStt,
    log,
    power: powerMonitor,
    onState: (snapshot) => {
      broadcast('recording:state', snapshot);
      autoStop.recordingState(snapshot);
      // Transcription came back: retry back-fill jobs that failed while it was down (2.7).
      const open = (['mic', 'system'] as const).filter((s) => snapshot.stt[s] === 'open');
      if (open.some((s) => sttOpen[s] !== true)) backfill.kick(undefined, true);
      sttOpen = { mic: open.includes('mic'), system: open.includes('system') };
    },
    onSegments: (batch) => broadcast('transcript:segments', batch),
    // 2.7: what live transcription lost is re-transcribed from the archive.
    onTranscriptGap: (gap) => backfill.enqueue({ ...gap, userId: signedInUser() }),
    onStatus: (status, meetingId) => {
      store.update((s) =>
        s.recording.status === status && s.activeMeetingId === meetingId
          ? s
          : { ...s, recording: { status }, activeMeetingId: meetingId },
      );
      if (status === 'idle') {
        backfill.kick();
        queueMicrotask(() => void sync.recordingEnded());
      }
      detection.setRecording(status !== 'idle' && status !== 'error');
    },
    // Storage (sizes, sweep, the player's `storage:changed`) once the files are closed, not at `idle`, when
    // they may still be closing and the meeting reads as "recording" (9.4).
    onArchiveClosed: () => storage.recordingEnded(),
  });
  quitGracefully(
    recording,
    () => notesFlush.request(),
    async () => {
      // A meeting in its grace period ends now; push it (≤ 5 s) so its notes are finished without waiting
      // for the next launch.
      if (!grace.flush()) return;
      await Promise.race([
        sync.syncNow().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    },
  );

  // --- Transcript back-fill from the archive + crash recovery (2.7, D-17) ---
  let sttOpen: { mic: boolean; system: boolean } = { mic: false, system: false };
  const backfill: TranscriptBackfill = new TranscriptBackfill({
    jobs: transcriptJobs,
    audio: audioIndex,
    liveAudio: () => recording.liveAudio(),
    busyMeetingId: () => recording.busyMeetingId,
    // D-30: the provider's tokens are only fetched while that account is still the signed-in one.
    createProvider: (userId) => setup.createBatchStt(() => signedInUser() === userId),
    // D-30: only the recording account's jobs, once its database is the open one.
    currentUser: () => {
      const user = signedInUser();
      return user && sync.store && sync.storeUser === user ? user : null;
    },
    store: () => sync.store,
    onSegments: (meetingId, segments) => {
      recording.addSegments(meetingId, segments);
      sync.kick();
    },
    onChange: () => meetingsChanged(),
    onMeetingChanged: () => {
      sync.kick();
      meetingsChanged();
    },
    log,
  });
  bridge.handle('meeting:transcript-status', ({ meetingId }) => backfill.status(meetingId));

  // --- Audio archive storage + retention (3.8, D-10) ---
  let storageSeq = 0;
  let storageUser: string | null = null;
  const storage = new AudioStorage({
    baseDir: app.getPath('userData'),
    store: audioIndex,
    settingsFile: join(app.getPath('userData'), 'audio-retention.json'),
    // D-30: only the signed-in account's audio, once its database is the open one.
    currentUser: () => {
      const user = signedInUser();
      return user && sync.store && sync.storeUser === user ? user : null;
    },
    activeMeeting: () => recording.busyMeetingId,
    meetingInfo: (meetingId) => {
      const local = sync.store;
      const user = signedInUser();
      const meeting = local?.meeting(meetingId);
      if (!local || !meeting || !user || sync.storeUser !== user) return null;
      const doc = local.document(meeting.documentId);
      return {
        title: doc && !doc.deletedAt ? doc.title : null,
        recorded: meeting.startedAt !== null,
        owned: doc?.ownerId === user,
      };
    },
    reveal: (path) => shell.showItemInFolder(path),
    onChanged: () => broadcast('storage:changed', { seq: ++storageSeq }),
    log,
  });
  const storageCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof StorageError) throw new BridgeError(error.code, error.message);
      throw error;
    }
  };
  bridge.handle('storage:list', () => storage.summary());
  bridge.handle('storage:delete-audio', ({ meetingId }) =>
    storageCall(() => storage.deleteAudio(meetingId)),
  );
  bridge.handle('storage:show', ({ meetingId }) => storageCall(() => storage.show(meetingId)));
  bridge.handle('storage:preview-policy', ({ policy }) => storage.preview(policy));
  bridge.handle('storage:set-policy', ({ policy }) => storageCall(() => storage.setPolicy(policy)));
  bridge.handle('storage:audio-status', ({ meetingId }) =>
    storageCall(() => storage.audioStatus(meetingId)),
  );
  // The sweeper waits for crash recovery (it must not race the repair of a file).
  void recovered.then(() => storage.start());

  // --- Playback (3.7): the meeting's audio on the meeting clock, served to the renderer's <audio> ---
  const playback = new AudioPlayback({
    playable: (meetingId) => storage.playable(meetingId),
    currentUser: () => {
      const user = signedInUser();
      return user && sync.store && sync.storeUser === user ? user : null;
    },
    log,
  });
  bridge.handle('playback:open', async ({ meetingId }) => {
    try {
      return await playback.open(meetingId);
    } catch (error) {
      if (error instanceof PlaybackError) throw new BridgeError(error.code, error.message);
      if (error instanceof StorageError) throw new BridgeError(error.code, error.message);
      throw error;
    }
  });
  protocol.handle(PLAYBACK_SCHEME, (request) =>
    playback.handle(request).catch((error: unknown) => {
      log.error('playback: request failed', error);
      return new Response('Playback failed', { status: 500 });
    }),
  );

  app.once('will-quit', () => {
    storage.stop();
    backfill.stop();
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
    recordingCall(async () => {
      if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in to record.');
      if (request.meetingId && sync.store?.meeting(request.meetingId)) {
        // Continuing a meeting (D-24): only an editable note recorded on this Mac.
        const reason = await notes.cannotContinue(request.meetingId);
        if (reason) throw new BridgeError('invalid_state', reason);
      }
      const spec = setup.resolveInput(request);
      if (testRecording.busy) await testRecording.stop(); // 9.2: one audio input at a time
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

  // --- Calendar notes + meeting detection (7.3) ---
  const calendarSetup = createCalendarSetup({
    calendar: config.calendar,
    detection: config.detection,
    isPackaged: app.isPackaged,
    env: process.env,
    ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : {}),
    openExternal: (url) => void shell.openExternal(url),
    log,
  });
  const calendar: CalendarService = new CalendarService({
    local: calendarSetup.localCalendar(),
    google: {
      fetch: (signal) =>
        auth.withSession((token) => api.calendarUpcoming(token, { days: 2, limit: 50, signal })),
      openConnect: () =>
        void shell.openExternal(new URL('/settings/integrations', config.webUrl).toString()),
    },
    user: signedInUser,
    noteFor: (keys) => notes.findByCalendarKeys(keys),
    onEvents: (events) => {
      detection.setEvents(events);
      autoStop.setEvents(events);
    },
    onSnapshot: (snapshot) => broadcast('calendar:changed', snapshot),
    onStartingSoon: (event) => detection.startingSoon(event),
    log,
  });
  const detection: DetectionService = new DetectionService({
    source: calendarSetup.micApps(),
    dir: app.getPath('userData'),
    calendar,
    startNotes: async ({ event, input, fixture }) => {
      if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in to record.');
      if (recording.busy) throw new BridgeError('invalid_state', 'Oat is already recording.');
      let meetingId: string | undefined;
      let documentId: string | null = null;
      if (event) {
        const note = await notes.fromEvent(event);
        // A note recorded on another device can't be continued here (D-24): record into a new one.
        if (!(await notes.cannotContinue(note.meetingId))) {
          ({ meetingId, documentId } = note);
        }
      }
      const spec = setup.resolveInput({
        ...(input ? { input } : {}),
        ...(fixture ? { fixture } : {}),
      });
      if (testRecording.busy) await testRecording.stop(); // 9.2: one audio input at a time
      const started = await recording.start({ ...(meetingId ? { meetingId } : {}), spec });
      documentId ??= (await notes.get({ meetingId: started.meetingId }))?.documentId ?? null;
      return { documentId };
    },
    notify: showNotification,
    onPrompt: (prompt) => broadcast('prompt:changed', { prompt }),
    onOpened: (documentId) => {
      focusMainWindow();
      if (documentId) broadcast('notes:open', { documentId });
    },
    // 7.5: calls ending / coming back drive auto-stop.
    onMeetingEnded: (action) => autoStop.meetingEnded(action),
    onCallChanged: (open) => autoStop.callChanged(open),
    onAppsChanged: (appIds) => autoStop.appsChanged(appIds),
    log,
  });

  // --- Auto-stop + the grace period + post-meeting status (7.5) ---
  const autoStop: AutoStopService = new AutoStopService({
    settingsFile: join(app.getPath('userData'), 'auto-stop.json'),
    config: config.autoStop,
    stop: () => recording.stop(),
    // The note's own event (made from the calendar, 7.3: `calendar_event_id` holds the meeting key).
    eventOf: (meetingId) => {
      const key = sync.store?.meeting(meetingId)?.calendarEventId;
      return key ? (calendar.findByKey(key)?.id ?? null) : null;
    },
    notify: showNotification,
    onNotice: (notice) => broadcast('autostop:changed', { notice }),
    onOpen: () => focusMainWindow(),
    log,
  });
  autoStop.setEvents(calendar.events);
  app.once('will-quit', () => {
    autoStop.dispose();
    grace.dispose();
  });
  bridge.handle('autostop:get', () => autoStop.notice);
  bridge.handle('autostop:respond', async ({ id, action }) => {
    try {
      await autoStop.respond(id, action);
    } catch (error) {
      if (error instanceof AutoStopServiceError) {
        throw new BridgeError('invalid_state', error.message);
      }
      throw error;
    }
  });
  bridge.handle('autostop:get-settings', () => autoStop.settings);
  bridge.handle('autostop:set-settings', (patch) => autoStop.setSettings(patch));
  bridge.handle('grace:get', () => {
    const p = grace.pending;
    return p && { meetingId: p.meetingId, endedAt: p.endedAt, dueAt: p.dueAt };
  });
  bridge.handle('grace:finish-now', ({ meetingId }) => void grace.flush(meetingId));
  const pipelineCall = async (documentId: string, retry: boolean) => {
    if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in first.');
    try {
      return await auth.withSession((token) => api.pipeline(token, documentId, { retry }));
    } catch (error) {
      if (error instanceof ApiError) {
        throw new BridgeError(
          error.status === 401
            ? 'unauthorized'
            : error.status === 403 || error.status === 409
              ? 'invalid_state'
              : 'unavailable',
          error.message,
        );
      }
      throw error;
    }
  };
  bridge.handle('pipeline:get', ({ documentId }) => pipelineCall(documentId, false));
  bridge.handle('pipeline:retry', ({ documentId }) => pipelineCall(documentId, true));
  app.once('will-quit', () => {
    void detection.stop();
    void calendar.stop();
  });
  bridge.handle('calendar:get', () => calendar.snapshot);
  bridge.handle('calendar:refresh', () => calendar.refresh());
  bridge.handle('calendar:connect', ({ provider }) => calendar.connect(provider));
  bridge.handle('calendar:start-notes', ({ eventId }) =>
    notesCall(async () => {
      if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in first.');
      const event = calendar.find(eventId);
      if (!event)
        throw new BridgeError('invalid_state', 'That event isn’t in your calendar anymore.');
      return notes.fromEvent(event);
    }),
  );
  bridge.handle('prompt:get', () => detection.prompt);
  bridge.handle('prompt:respond', ({ promptId, action, input, fixture }) =>
    recordingCall(() =>
      notesCall(async () => {
        try {
          return await detection.respond(promptId, action, {
            ...(input ? { input } : {}),
            ...(fixture ? { fixture } : {}),
          });
        } catch (error) {
          if (error instanceof DetectionServiceError) {
            throw new BridgeError('invalid_state', error.message);
          }
          throw error;
        }
      }),
    ),
  );

  // --- First-run setup: permissions walkthrough, test recording, first-meeting guide (9.2) ---
  const permissions: PermissionSource = createPermissionSource(() => setup.sidecarBinary());
  const onboarding = new OnboardingStore({
    file: join(app.getPath('userData'), 'onboarding.json'),
    mode: config.onboarding,
    log,
  });
  const permissionsSnapshot = async (): Promise<PermissionsSnapshot> => {
    const audio = await permissions.status();
    const { eventkit, google } = calendar.snapshot;
    return { ...audio, calendar: eventkit, google };
  };
  bridge.handle('permissions:get', () => permissionsSnapshot());
  bridge.handle('permissions:request', async ({ kind }) => {
    // Only the user's "Allow" click gets here; macOS is asked only while it never was.
    if (kind === 'calendar') {
      if (calendar.snapshot.eventkit === 'not_determined') await calendar.connect('eventkit');
    } else {
      const audio = await permissions.status();
      if (canRequest(kind === 'microphone' ? audio.microphone : audio.systemAudio)) {
        await permissions.request(kind);
      }
    }
    const snapshot = await permissionsSnapshot();
    broadcast('permissions:changed', snapshot);
    return snapshot;
  });
  bridge.handle('permissions:open-settings', ({ kind }) => {
    void shell.openExternal(PRIVACY_URLS[kind]);
  });
  const onboardingUser = () => {
    const user = signedInUser();
    if (!user) throw new BridgeError('unauthorized', 'Sign in first.');
    return user;
  };
  bridge.handle('onboarding:get', () => onboarding.state(signedInUser()));
  bridge.handle('onboarding:complete', ({ guide }) => onboarding.complete(onboardingUser(), guide));
  bridge.handle('onboarding:dismiss-guide', () => onboarding.dismissGuide(onboardingUser()));
  const testRecording = new TestRecording({
    createSource: setup.createSource,
    createStt: (spec) => setup.createStt({ meetingId: 'test-recording', spec }),
    ...(config.testRecordingMs !== undefined ? { durationMs: config.testRecordingMs } : {}),
    onState: (snapshot) => broadcast('onboarding:test-state', snapshot),
    log,
  });
  app.once('will-quit', () => testRecording.dispose());
  bridge.handle('onboarding:test-get', () => testRecording.snapshot());
  bridge.handle('onboarding:test-stop', () => testRecording.stop());
  bridge.handle('onboarding:test-start', (request) =>
    recordingCall(async () => {
      if (!auth.signedIn) throw new BridgeError('unauthorized', 'Sign in first.');
      if (recording.busy) throw new BridgeError('invalid_state', 'Stop the recording first.');
      const spec = setup.resolveInput(request);
      try {
        return await testRecording.start(spec);
      } catch (error) {
        if (error instanceof TestRecordingError)
          throw new BridgeError('invalid_state', error.message);
        throw error;
      }
    }),
  );

  bridge.on('app:rendered', ({ window }) => {
    if (window !== 'main' || coldStartMs !== null) return;
    coldStartMs = Math.round(process.uptime() * 1000);
    log.info(`cold start: ${coldStartMs} ms (process start → main window rendered)`);
  });
  bridge.on('shell:open-external', ({ url }) => {
    const external = externalDocumentUrl(url, config.webUrl);
    if (external) void shell.openExternal(external);
  });

  let calendarUser: string | null = null;
  store.subscribe((snapshot) => {
    broadcast('state:changed', snapshot);
    // 7.5: an account change ends a meeting in its grace period first, while its database is still the open one.
    if (grace.pending && grace.pending.userId !== signedInUser()) grace.flush();
    if (snapshot.state.auth.status === 'signed-out') credentials.clear();
    // After this change has reached every listener (sync's own status updates go through the store).
    queueMicrotask(() => {
      const user = signedInUser();
      void sync.setUser(user).then(() => {
        // 3.8 / D-30: the storage view and the sweeper follow the account whose database is open.
        const current = sync.storeUser;
        grace.accountOpened(current); // 7.5: ends held from before a crash/quit, or for this account
        if (current !== storageUser) {
          storageUser = current;
          playback.revokeAll(); // D-30: another account's player URLs stop working
          storage.accountChanged();
          void recovered.then(() => backfill.kick(0));
        }
      });
    });
    // 7.3: Google events and "Start notes?" prompts belong to the signed-in account.
    const user = signedInUser();
    if (user !== calendarUser) {
      calendarUser = user;
      calendar.authChanged();
      if (user) void detection.start(user);
      else void detection.stop();
    }
  });
  openMainWindow();
  await auth.restore();
  void calendar.start();

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
 * Microphone / system-audio permission states (9.2): the sidecar's `permissions` (never prompts) and, on the
 * user's "Allow", the real request; or, in dev/e2e, a fixture file that answers in memory (no prompt ever).
 */
function createPermissionSource(binary: () => string): PermissionSource {
  const p = config.permissions;
  if (p.kind === 'fixture') {
    try {
      return FixturePermissions.fromFile(p.file);
    } catch (error) {
      log.error(`permissions: fixture ${p.file} unreadable`, error);
      return new FixturePermissions({ microphone: 'unknown', system_audio: 'unknown' });
    }
  }
  // e2e never touches the real permission state, even read-only: suites without a fixture see "unknown".
  if (config.e2e) return new FixturePermissions({ microphone: 'unknown', system_audio: 'unknown' });
  return new SidecarPermissions({
    binary,
    askForMicrophone: () =>
      process.platform === 'darwin'
        ? systemPreferences.askForMediaAccess('microphone')
        : Promise.resolve(true),
    env: process.env,
    log,
  });
}

/**
 * A native notification ("Start notes for …?", "… is starting"). e2e never shows one (it would pop up on the
 * developer's screen): it is recorded on `globalThis.__oatNotifications` for the test to inspect and click.
 */
function showNotification(request: NotifyRequest): ShownNotification | null {
  if (config.e2e) {
    const g = globalThis as { __oatNotifications?: (NotifyRequest & { closed: boolean })[] };
    const entry = { ...request, closed: false };
    (g.__oatNotifications ??= []).push(entry);
    return { close: () => void (entry.closed = true) };
  }
  if (!Notification.isSupported()) return null;
  const notification = new Notification({ title: request.title, body: request.body });
  notification.on('click', request.onClick);
  notification.show();
  return { close: () => notification.close() };
}

/**
 * Quitting first finishes what would otherwise be lost, then quits:
 * - note edits still in the main window's autosave debounce are written (3.4; at most 1 s);
 * - a recording (or a stop / an ended session's files still closing — `busy`) is shut down: last transcript
 *   finals, closed audio files, so a quit never leaves a half-written recording behind (recovery of crashed
 *   files is `recoverRecordings`);
 * - then a meeting still in its post-stop grace period (7.5) is ended and pushed (at most 5 s more).
 * Further quit requests while this runs wait for it too.
 */
function quitGracefully(
  recording: RecordingService,
  flushNotes: () => Promise<unknown>,
  /** After the recording is shut down (7.5: end a meeting still in its grace period, and push it). */
  afterRecording: () => Promise<void>,
) {
  let ready = false;
  let running = false;
  app.on('before-quit', (event) => {
    if (ready) return;
    event.preventDefault();
    if (running) return;
    running = true;
    if (recording.busy) log.info('quit: stopping the recording first');
    void Promise.allSettled([flushNotes(), recording.busy ? recording.shutdown() : undefined])
      .then(() => afterRecording())
      .catch((error: unknown) => log.error('quit: could not finish the meeting', error))
      .then(() => {
        ready = true;
        app.quit();
      });
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
