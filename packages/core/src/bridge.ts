/**
 * Desktop IPC bridge contract (task 1.8): the single source of truth for every channel between the
 * Electron renderer and the main process.
 *
 * - `invoke`: request → response (`ipcRenderer.invoke` / `ipcMain.handle`).
 * - `send`: fire-and-forget renderer → main (`ipcRenderer.send` / `ipcMain.on`).
 * - `subscribe`: main → renderer pushes (`webContents.send`); the renderer gets an unsubscribe function.
 *
 * The preload script exposes `window.oat` (`OatBridge`) generated from these channel lists; main
 * registers every handler through one helper that checks the sender frame and parses the payload with
 * the schema here. Responses and pushes are parsed in main too, before they leave. Nothing secret (the
 * session token) is ever part of a schema here.
 */
import { z } from 'zod';
import { apiInvokeChannels, apiSubscribeChannels } from './bridge-api.ts';

import { autoStopInvokeChannels, autoStopSubscribeChannels } from './bridge-auto-stop.ts';
import { calendarInvokeChannels, calendarSubscribeChannels } from './bridge-calendar.ts';
import {
  meetingInvokeChannels,
  meetingSendChannels,
  meetingSubscribeChannels,
} from './bridge-meetings.ts';
import { onboardingInvokeChannels, onboardingSubscribeChannels } from './bridge-onboarding.ts';
import { playbackInvokeChannels } from './bridge-playback.ts';
import { storageInvokeChannels, storageSubscribeChannels } from './bridge-storage.ts';
import { transcriptInvokeChannels } from './bridge-transcript.ts';

export * from './bridge-auto-stop.ts';
export * from './bridge-api.ts';
export * from './bridge-calendar.ts';
export * from './bridge-meetings.ts';
export * from './bridge-onboarding.ts';
export * from './bridge-playback.ts';
export * from './bridge-storage.ts';
export * from './bridge-transcript.ts';

/** Bumped when a channel changes incompatibly (renderer and preload ship together, so mostly a sanity check). */
export const BRIDGE_VERSION = 1;

/** Name of the global the preload script exposes (`window.oat`). */
export const BRIDGE_GLOBAL = 'oat';

// ---------------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------------

/** Window kinds; all of them load the same renderer bundle and pick their UI by route. */
export const WINDOW_KINDS = ['main', 'widget'] as const;
export const windowKindSchema = z.enum(WINDOW_KINDS);
export type WindowKind = z.infer<typeof windowKindSchema>;

/** The signed-in user as the desktop sees it (never the token). */
export const desktopUserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string().nullable(),
});
export type DesktopUser = z.infer<typeof desktopUserSchema>;

export const authStateSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('signed-out'),
    /** A user-facing reason the last attempt failed, if any. */
    error: z.string().nullable(),
  }),
  /** Launch: checking the stored token with the API. */
  z.object({ status: z.literal('restoring') }),
  /** The browser is open at the web sign-in page; waiting for the `oat://auth` deep link. */
  z.object({ status: z.literal('signing-in') }),
  z.object({ status: z.literal('signed-in'), user: desktopUserSchema }),
]);
export type AuthState = z.infer<typeof authStateSchema>;

// ---------------------------------------------------------------------------------------------------
// Recording + live transcript (task 2.5)
// ---------------------------------------------------------------------------------------------------

/**
 * `idle` → `starting` → `recording` ⇄ `paused` → `stopping` → `idle`; `error` = the audio stopped by
 * itself (or never started) and stays until acknowledged with `recording:stop` or a new start. Mirrors
 * `@oat/audio` `RecordingState`.
 */
export const RECORDING_STATUSES = [
  'idle',
  'starting',
  'recording',
  'paused',
  'stopping',
  'error',
] as const;
export const recordingStatusSchema = z.enum(RECORDING_STATUSES);
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

/** `mic` = "me", `system` = "them" (never mixed, D-17). */
export const audioSourceKindSchema = z.enum(['mic', 'system']);

/**
 * Where audio comes from: the Swift sidecar (live capture) or a WAV fixture replayed by `FileSource`
 * (development and tests only; refused in a packaged app).
 */
export const recordingInputSchema = z.enum(['sidecar', 'file']);
export type RecordingInput = z.infer<typeof recordingInputSchema>;

/** A plain id usable as a folder name (`@oat/audio` archive paths): no separators, no dots. */
export const meetingIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
/** Fixture names as in `fixtures/audio/<name>.wav`. */
export const fixtureNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** Per-source live transcription status: `idle` when no stream is open, else `@oat/stt` `SttStatus`. */
export const sttStreamStatusSchema = z.enum([
  'idle',
  'connecting',
  'open',
  'reconnecting',
  'closed',
  'error',
]);
export type SttStreamStatus = z.infer<typeof sttStreamStatusSchema>;

/** Latest level of one source (dBFS, −100 = silence). */
export const audioLevelSchema = z.object({ rmsDb: z.number(), peakDb: z.number() });
export type AudioLevel = z.infer<typeof audioLevelSchema>;

/**
 * Something the user must see (SPEC §8: recording never stops silently). `scope` says which part failed:
 * `audio` (capture), `stt` (transcription; the recording carries on), `archive` (the local audio file).
 */
export const recordingIssueSchema = z.object({
  id: z.number().int().nonnegative(),
  scope: z.enum(['audio', 'stt', 'archive']),
  code: z.string().max(64),
  message: z.string().max(500),
  source: audioSourceKindSchema.nullable(),
  /** This ended that part (capture stopped, or that source's transcription gave up). */
  fatal: z.boolean(),
  /** Wall clock (Unix ms) of the latest occurrence. */
  at: z.number(),
  /** How often it happened (a retry loop repeats the same issue; it is listed once). */
  count: z.number().int().positive(),
});
export type RecordingIssue = z.infer<typeof recordingIssueSchema>;

export const recordingSnapshotSchema = z.object({
  /** Bumped on every change; windows ignore anything older than what they show. */
  seq: z.number().int().nonnegative(),
  status: recordingStatusSchema,
  meetingId: z.string().nullable(),
  input: recordingInputSchema.nullable(),
  /** Fixture being replayed (`input: 'file'`). */
  fixture: fixtureNameSchema.nullable(),
  /** Wall clock (Unix ms) of the `started` event, i.e. where this session starts. */
  startedAt: z.number().nullable(),
  /** Recorded (not paused) time as of `elapsedAt` (Unix ms); windows tick it forward while recording. */
  elapsedMs: z.number().nonnegative(),
  elapsedAt: z.number(),
  levels: z.object({ mic: audioLevelSchema.nullable(), system: audioLevelSchema.nullable() }),
  stt: z.object({ mic: sttStreamStatusSchema, system: sttStreamStatusSchema }),
  /** Issues of the current (or last) recording, oldest first, at most 20. Cleared by the next start. */
  issues: z.array(recordingIssueSchema).max(20),
});
export type RecordingSnapshot = z.infer<typeof recordingSnapshotSchema>;

/**
 * One transcript segment on the **meeting clock** (ms since the meeting's first recording started). D-19:
 * `id` is stable; an interim and the final that replaces it share it. A final with `text: ''` is a
 * retraction: drop the segment with that id.
 */
export const liveSegmentSchema = z.object({
  id: z.string().min(1).max(64),
  source: audioSourceKindSchema,
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string().max(10_000),
  isFinal: z.boolean(),
  /** Filled in from the local audio archive after a transcription outage (2.7). */
  backfilled: z.boolean().optional(),
});
export type LiveSegment = z.infer<typeof liveSegmentSchema>;

/** A batch of segment upserts/retractions, pushed every ~50 ms while segments arrive. */
export const transcriptBatchSchema = z.object({
  meetingId: z.string(),
  /** +1 per batch of this meeting; the first batch after a `transcript:get` snapshot is snapshot + 1. */
  seq: z.number().int().positive(),
  segments: z.array(liveSegmentSchema).max(5000),
});
export type TranscriptBatch = z.infer<typeof transcriptBatchSchema>;

/** The whole live transcript of the active meeting (no retractions), in time order. */
export const transcriptSnapshotSchema = z.object({
  meetingId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  segments: z.array(liveSegmentSchema).max(200_000),
});
export type TranscriptSnapshot = z.infer<typeof transcriptSnapshotSchema>;

/** One archived audio file of a stopped session (D-10, D-24); never its path. */
export const archivedAudioSchema = z.object({
  source: audioSourceKindSchema,
  part: z.number().int().positive(),
  status: z.enum(['recording', 'complete', 'partial', 'failed', 'deleted']),
  durationMs: z.number().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ArchivedAudio = z.infer<typeof archivedAudioSchema>;

/** What the recording UI may offer. */
export const recordingOptionsSchema = z.object({
  /** What `recording:start` without `input` uses (`OAT_AUDIO_SOURCE` in dev; the sidecar when packaged). */
  defaultInput: recordingInputSchema,
  defaultFixture: fixtureNameSchema.nullable(),
  /** Fixtures that can be replayed instead of the mic (dev only; empty in a packaged app). */
  fixtures: z.array(fixtureNameSchema).max(50),
});
export type RecordingOptions = z.infer<typeof recordingOptionsSchema>;

// ---------------------------------------------------------------------------------------------------
// Sync (task 2.6, D-19)
// ---------------------------------------------------------------------------------------------------

/**
 * `idle` = caught up (or between runs); `syncing` = a run is in flight; `offline` = the server can't be
 * reached (changes stay on this Mac, retried with backoff); `error` = the server refused or failed
 * (retried); `stopped` = signed out.
 */
export const SYNC_STATES = ['idle', 'syncing', 'offline', 'error', 'stopped'] as const;
export const syncStatusSchema = z.object({
  state: z.enum(SYNC_STATES),
  /** Local changes the server hasn't acknowledged yet. */
  pending: z.number().int().nonnegative(),
  /** Changes that couldn't be sent as they are: kept on this Mac and retried later (D-28). */
  parked: z.number().int().nonnegative(),
  /** Wall clock (Unix ms) of the last complete sync. */
  lastSyncedAt: z.number().nullable(),
  error: z.string().max(500).nullable(),
});
export type SyncStatusSnapshot = z.infer<typeof syncStatusSchema>;

// Local search + conflicted copies (task 3.5) ---------------------------------------------------------

/** A local full-text hit (`@oat/local-store` `search`); `snippet` marks matches with \u0001…\u0002. */
export const searchHitSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  kind: z.enum(['meeting', 'page']),
  in: z.enum(['note', 'transcript']),
  snippet: z.string(),
  segmentId: z.string().nullable(),
  startMs: z.number().nullable(),
  updatedAt: z.string(),
});
export type SearchHitSnapshot = z.infer<typeof searchHitSchema>;

export const conflictSummarySchema = z.object({
  copyId: z.string(),
  title: z.string(),
  device: z.string().nullable(),
  at: z.string().nullable(),
  originalId: z.string().nullable(),
  originalTitle: z.string().nullable(),
});
export type ConflictSummary = z.infer<typeof conflictSummarySchema>;

const diffLineSchema = z.object({ text: z.string(), changed: z.boolean() });
export const conflictDetailSchema = z.object({
  summary: conflictSummarySchema,
  /** Side by side: the other (server) version and this copy, as compared lines. */
  original: z.array(diffLineSchema).nullable(),
  copy: z.array(diffLineSchema),
});
export type ConflictDetailSnapshot = z.infer<typeof conflictDetailSchema>;

/**
 * Small cross-window live state owned by the main process. Volatile: rebuilt on every launch (auth is
 * restored from the stored token; recording and meeting start idle).
 */
export const mainStateSchema = z.object({
  auth: authStateSchema,
  /** Coarse recording status for every window; the detail is on `recording:state`. */
  recording: z.object({ status: recordingStatusSchema }),
  /** The meeting being recorded (or the last one recorded since launch). */
  activeMeetingId: z.string().nullable(),
  /** Desktop sync (2.6). */
  sync: syncStatusSchema,
});
export type MainState = z.infer<typeof mainStateSchema>;

/** A state snapshot with its sequence number; every change increments `seq` by one. */
export const mainStateSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  state: mainStateSchema,
});
export type MainStateSnapshot = z.infer<typeof mainStateSnapshotSchema>;

export const appInfoSchema = z.object({
  version: z.string(),
  platform: z.string(),
  /** `true` when running from the electron-vite dev server (not a built renderer). */
  dev: z.boolean(),
  /** A released (packaged) app: no dev-only affordances such as pasting a sign-in link. */
  packaged: z.boolean(),
  /** Process start → first main-window render, once known. */
  coldStartMs: z.number().nonnegative().nullable(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

const none = z.undefined();

// ---------------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------------

export const bridgeContract = {
  invoke: {
    ...apiInvokeChannels,
    'app:info': { request: none, response: appInfoSchema },
    'state:get': { request: none, response: mainStateSnapshotSchema },
    /** Opens the system browser at the web sign-in page. */
    'auth:sign-in': { request: none, response: z.object({ opened: z.boolean() }) },
    'settings:open-web': {
      request: z.object({
        section: z.enum(['profile', 'preferences', 'integrations', 'workspace', 'members']),
      }),
      response: none,
    },
    'auth:cancel-sign-in': { request: none, response: none },
    /**
     * Development fallback when the browser can't hand the `oat://auth?…` link to the app (the dev
     * Electron binary isn't the registered handler): the user pastes it. Same checks as a real deep link.
     * Refused (`forbidden`) in a packaged app: a pasteable code is a phishing target (1.8 review).
     */
    'auth:complete-from-link': {
      request: z.object({ url: z.string().max(2048) }),
      response: z.object({ accepted: z.boolean() }),
    },
    /** Revokes the session on the server (best effort) and forgets the token. */
    'auth:sign-out': { request: none, response: none },
    /** Smoke call through the main-process API client (bearer token stays in main). */
    'api:me': {
      request: none,
      response: z.object({ user: desktopUserSchema, activeWorkspaceId: z.string().nullable() }),
    },
    /** Recording options for the UI (default input, dev fixtures). */
    'recording:options': { request: none, response: recordingOptionsSchema },
    /**
     * Starts recording (signed in only). `meetingId` continues an existing meeting (a new part, D-24);
     * without one a new meeting id is created. `input` defaults to `recording:options` `defaultInput`.
     */
    'recording:start': {
      request: z.strictObject({
        meetingId: meetingIdSchema.optional(),
        input: recordingInputSchema.optional(),
        fixture: fixtureNameSchema.optional(),
      }),
      response: z.object({ meetingId: z.string() }),
    },
    'recording:pause': { request: none, response: none },
    'recording:resume': { request: none, response: none },
    /** Stops (or acknowledges an error); resolves once the audio files are closed. */
    'recording:stop': {
      request: none,
      response: z.object({ meetingId: z.string().nullable(), audio: z.array(archivedAudioSchema) }),
    },
    'recording:get': { request: none, response: recordingSnapshotSchema },
    'transcript:get': { request: none, response: transcriptSnapshotSchema },
    /** Sync now (push the outbox, then pull); resolves with the status after the run. */
    'sync:now': { request: none, response: syncStatusSchema },
    /** Local full-text search over notes and transcripts (3.5; works offline). */
    'search:query': {
      request: z.strictObject({ query: z.string().max(200) }),
      response: z.object({ hits: z.array(searchHitSchema) }),
    },
    /** Conflicted copies on this Mac (3.5). */
    'conflicts:list': {
      request: none,
      response: z.object({ conflicts: z.array(conflictSummarySchema) }),
    },
    'conflicts:get': {
      request: z.strictObject({ copyId: z.string().min(1).max(100) }),
      response: conflictDetailSchema.nullable(),
    },
    /** Keep the copy's text (it replaces the original) or the original; the copy is deleted. Synced. */
    'conflicts:resolve': {
      request: z.strictObject({
        copyId: z.string().min(1).max(100),
        keep: z.enum(['copy', 'original']),
      }),
      response: z.object({ resolved: z.boolean() }),
    },
    'window:open-widget': { request: none, response: none },
    'window:close-widget': { request: none, response: none },
    /** Meeting note view (3.4). */
    ...meetingInvokeChannels,
    /** Calendar notes + meeting detection (7.3). */
    ...calendarInvokeChannels,
    /** Auto-stop, the post-stop grace period and the post-meeting status (7.5), `bridge-auto-stop.ts`. */
    ...autoStopInvokeChannels,
    /** Audio archive storage + retention (3.8), `bridge-storage.ts`. */
    ...storageInvokeChannels,
    /** Listening back to a meeting's local audio (3.7), `bridge-playback.ts`. */
    ...playbackInvokeChannels,
    /** Transcript back-fill + crash recovery (2.7), `bridge-transcript.ts`. */
    ...transcriptInvokeChannels,
    /** First-run setup: permissions, test recording, first-meeting guide (9.2), `bridge-onboarding.ts`. */
    ...onboardingInvokeChannels,
  },
  send: {
    /** The window's UI has rendered (used for the cold-start measurement). */
    'app:rendered': z.object({ window: windowKindSchema }),
    /** Open an http(s) link in the system browser (main re-checks the URL). */
    'shell:open-external': z.object({ url: z.string().max(2048) }),
    ...meetingSendChannels,
  },
  subscribe: {
    ...apiSubscribeChannels,
    'state:changed': mainStateSnapshotSchema,
    /** Detailed recording state (levels, per-source STT status, issues), at most ~10 per second. */
    'recording:state': recordingSnapshotSchema,
    /** Transcript deltas of the active meeting (batched). */
    'transcript:segments': transcriptBatchSchema,
    ...meetingSubscribeChannels,
    ...calendarSubscribeChannels,
    ...autoStopSubscribeChannels,
    ...storageSubscribeChannels,
    ...onboardingSubscribeChannels,
  },
} as const;

export type BridgeContract = typeof bridgeContract;
export type InvokeChannel = keyof BridgeContract['invoke'];
export type SendChannel = keyof BridgeContract['send'];
export type SubscribeChannel = keyof BridgeContract['subscribe'];

export type InvokeRequest<C extends InvokeChannel> = z.output<
  BridgeContract['invoke'][C]['request']
>;
export type InvokeResponse<C extends InvokeChannel> = z.output<
  BridgeContract['invoke'][C]['response']
>;
export type SendPayload<C extends SendChannel> = z.output<BridgeContract['send'][C]>;
export type SubscribePayload<C extends SubscribeChannel> = z.output<BridgeContract['subscribe'][C]>;

/** Channels whose request is `undefined` take no argument. */
export type InvokeArgs<C extends InvokeChannel> =
  InvokeRequest<C> extends undefined ? [] : [payload: InvokeRequest<C>];

/** Every channel name by kind (what the preload exposes; anything else is refused before IPC). */
export const bridgeChannels = {
  invoke: Object.keys(bridgeContract.invoke) as InvokeChannel[],
  send: Object.keys(bridgeContract.send) as SendChannel[],
  subscribe: Object.keys(bridgeContract.subscribe) as SubscribeChannel[],
} as const;

// ---------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------

/**
 * Why an invoke failed. `forbidden`: the sender isn't our renderer; `invalid_payload`: the request
 * failed its schema; `unauthorized`: not signed in (or the token was revoked); `unavailable`: the API
 * (or, for recording, the audio input) couldn't be reached; `invalid_state`: not possible right now
 * (e.g. pause while not recording); `internal`: anything else (details stay in the main-process log).
 */
export const BRIDGE_ERROR_CODES = [
  'forbidden',
  'invalid_payload',
  'unauthorized',
  'unavailable',
  'invalid_state',
  'internal',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/**
 * What `invoke` resolves to. Errors are values, not rejections: Electron flattens a thrown Error into a
 * string, and the renderer needs the code.
 */
export type InvokeResult<C extends InvokeChannel> =
  | { ok: true; value: InvokeResponse<C> }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

/** `window.oat`, as exposed by the preload script. */
export interface OatBridge {
  readonly version: number;
  readonly platform: string;
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>>;
  send<C extends SendChannel>(channel: C, payload: SendPayload<C>): void;
  /** Returns the unsubscribe function. */
  subscribe<C extends SubscribeChannel>(
    channel: C,
    listener: (payload: SubscribePayload<C>) => void,
  ): () => void;
}

/** What every launch starts from: auth is `restoring` until the stored token (if any) is checked. */
export function initialMainState(): MainState {
  return {
    auth: { status: 'restoring' },
    recording: { status: 'idle' },
    activeMeetingId: null,
    sync: { state: 'stopped', pending: 0, parked: 0, lastSyncedAt: null, error: null },
  };
}
