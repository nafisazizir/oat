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

/**
 * Small cross-window live state owned by the main process. Volatile: rebuilt on every launch (auth is
 * restored from the stored token; recording and meeting start idle).
 */
export const mainStateSchema = z.object({
  auth: authStateSchema,
  /** Placeholder until recording lands (2.5). */
  recording: z.object({ status: z.enum(['idle', 'recording', 'paused']) }),
  activeMeetingId: z.string().nullable(),
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
    'app:info': { request: none, response: appInfoSchema },
    'state:get': { request: none, response: mainStateSnapshotSchema },
    /** Opens the system browser at the web sign-in page. */
    'auth:sign-in': { request: none, response: z.object({ opened: z.boolean() }) },
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
    'window:open-widget': { request: none, response: none },
    'window:close-widget': { request: none, response: none },
  },
  send: {
    /** The window's UI has rendered (used for the cold-start measurement). */
    'app:rendered': z.object({ window: windowKindSchema }),
    /** Open an http(s) link in the system browser (main re-checks the URL). */
    'shell:open-external': z.object({ url: z.string().max(2048) }),
  },
  subscribe: {
    'state:changed': mainStateSnapshotSchema,
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
 * couldn't be reached; `internal`: anything else (details stay in the main-process log).
 */
export const BRIDGE_ERROR_CODES = [
  'forbidden',
  'invalid_payload',
  'unauthorized',
  'unavailable',
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
  };
}
