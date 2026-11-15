/**
 * Desktop sync (task 2.6, D-19, D-28): one local database per user, and the `@oat/local-store`
 * `SyncEngine` bound to the signed-in user's.
 *
 * - Files: `<userData>/oat-<userId>.sqlite`. Signing in opens (or creates) that user's file; signing out
 *   stops syncing and keeps it open (the same user signing back in carries on, unsynced work included).
 * - Another account: the engine stops, its in-flight run is awaited (`idle()`), the previous user's file is
 *   closed — **kept**, never deleted — and the new user's file opened. Never while a recording is running:
 *   the switch waits until it has ended (`recordingEnded()`), so a meeting's rows always land in the file of
 *   the user who started it. (The UI refuses to start another sign-in while recording too.)
 * - A database that can't be opened right now (busy, disk full…) is reported in the status and retried;
 *   its file is left alone (only corruption leads to a rebuild, inside `LocalStore`).
 * - Status goes to `MainStore.sync` (every window) through `onStatus`.
 */
import { join } from 'node:path';

import {
  LocalStore,
  SyncEngine,
  type SyncEngineOptions,
  type SyncStatus,
  type SyncTransport,
} from '@oat/local-store';

import type { Logger } from './ipc.ts';

export interface SyncServiceOptions {
  /** Folder of the per-user database files (`app.getPath('userData')`). */
  dir: string;
  transport: SyncTransport;
  onStatus: (status: SyncStatus) => void;
  /** The server refused the session (401): the app should sign out. */
  onUnauthorized?: () => void;
  /** A recording is running (an account switch waits for it to end). */
  isRecording: () => boolean;
  log: Logger;
  /** Opens a user's database (tests). Default: `new LocalStore`. */
  openStore?: (path: string) => LocalStore;
  /** Retry delay after a database couldn't be opened. Default 5 s. */
  retryOpenMs?: number;
  /** Engine overrides (timers, intervals) for tests. */
  engine?: Partial<SyncEngineOptions>;
}

const STOPPED: SyncStatus = {
  state: 'stopped',
  pending: 0,
  parked: 0,
  lastSyncedAt: null,
  error: null,
};

/** `oat-<userId>.sqlite` with anything but `[A-Za-z0-9_-]` replaced. */
export function databaseFileFor(userId: string): string {
  return `oat-${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.sqlite`;
}

export class SyncService {
  readonly #o: SyncServiceOptions;
  #store: LocalStore | null = null;
  #storeUser: string | null = null;
  #engine: SyncEngine | null = null;
  /** The user the app is signed in as (`null` = signed out). */
  #wanted: string | null = null;
  /** The user the last `#apply` settled on (`undefined` before the first). */
  #applied: string | null | undefined = undefined;
  #chain: Promise<void> = Promise.resolve();
  #retry: ReturnType<typeof setTimeout> | undefined;
  #status: SyncStatus = STOPPED;

  constructor(options: SyncServiceOptions) {
    this.#o = options;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  /** The open database (the signed-in user's, or the previous user's until a deferred switch). */
  get store(): LocalStore | null {
    return this.#store;
  }

  /** Whose database is open. */
  get storeUser(): string | null {
    return this.#storeUser;
  }

  /** The signed-in user changed (`null` = signed out). Resolves once the change is applied (or deferred). */
  setUser(userId: string | null): Promise<void> {
    // Called on every MainStore change (including our own status updates): only act on a real change.
    if (userId === this.#wanted && this.#applied === userId) return this.#chain;
    this.#wanted = userId;
    this.#chain = this.#chain
      .then(() => this.#apply())
      .catch((error: unknown) => {
        this.#o.log.error('sync: switching the local database failed', error);
      });
    return this.#chain;
  }

  /** A recording ended: carry out an account switch that had to wait. */
  recordingEnded(): Promise<void> {
    return this.#wanted !== this.#storeUser ? this.setUser(this.#wanted) : this.#chain;
  }

  async #apply(): Promise<void> {
    clearTimeout(this.#retry);
    const wanted = this.#wanted;
    this.#applied = wanted;
    if (wanted === null) {
      this.#engine?.stop();
      this.#emit(STOPPED);
      return;
    }
    if (wanted === this.#storeUser && this.#engine) {
      this.#engine.start();
      return;
    }
    if (this.#store && this.#o.isRecording()) {
      this.#o.log.warn('sync: account changed while recording; switching once the recording ends');
      this.#engine?.stop();
      this.#applied = undefined;
      return;
    }
    if (this.#engine) {
      this.#engine.stop();
      await this.#engine.idle();
      this.#engine = null;
    }
    if (this.#store) {
      this.#store.close(); // kept on disk: that user gets it back on their next sign-in
      this.#store = null;
      this.#storeUser = null;
    }
    const path = join(this.#o.dir, databaseFileFor(wanted));
    try {
      const store = (this.#o.openStore ?? ((p) => new LocalStore({ path: p, log: this.#o.log })))(
        path,
      );
      if (store.wiped) this.#o.log.warn(`sync: local database was rebuilt (${store.wiped})`);
      this.#store = store;
      this.#storeUser = wanted;
    } catch (error) {
      this.#o.log.error('sync: the local database can’t be opened; retrying', error);
      this.#emit({
        ...STOPPED,
        state: 'error',
        error: 'The local database on this Mac can’t be opened right now; retrying.',
      });
      this.#applied = undefined;
      this.#retry = setTimeout(() => void this.setUser(this.#wanted), this.#o.retryOpenMs ?? 5_000);
      this.#retry.unref?.();
      return;
    }
    this.#engine = new SyncEngine({
      store: this.#store,
      transport: this.#o.transport,
      onStatus: (status) => this.#emit(status),
      log: this.#o.log,
      ...(this.#o.onUnauthorized ? { onUnauthorized: this.#o.onUnauthorized } : {}),
      ...this.#o.engine,
    });
    this.#engine.start();
  }

  #emit(status: SyncStatus): void {
    const cur = this.#status;
    if (
      cur.state === status.state &&
      cur.pending === status.pending &&
      cur.parked === status.parked &&
      cur.lastSyncedAt === status.lastSyncedAt &&
      cur.error === status.error
    ) {
      return;
    }
    this.#status = status;
    this.#o.onStatus(status);
  }

  /** A local write happened. */
  kick(): void {
    this.#engine?.kick();
  }

  async syncNow(): Promise<SyncStatus> {
    await this.#chain;
    return this.#engine ? this.#engine.syncNow() : this.#status;
  }

  /**
   * The user's personal workspace (where new meetings go). Known after the first pull; if it isn't yet,
   * keeps syncing (bounded by `timeoutMs`; a pull can come back empty for a moment, D-22). `null` when it
   * still can't be known (offline on a fresh database).
   */
  async personalWorkspace(timeoutMs = 10_000): Promise<string | null> {
    await this.#chain;
    const deadline = Date.now() + timeoutMs;
    const known = () => this.#store?.personalWorkspaceId() ?? null;
    for (let engine = this.#engine; engine?.started && !known() && Date.now() < deadline;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        engine.syncNow().catch(() => undefined),
        new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now())))),
      ]);
      clearTimeout(timer);
      if (!known() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      }
      engine = this.#engine;
    }
    return known();
  }

  /** Quit: stop scheduling, await a run in flight, close the database. */
  async shutdown(): Promise<void> {
    clearTimeout(this.#retry);
    await this.#chain;
    this.#engine?.stop();
    await this.#engine?.idle();
    this.#store?.close();
  }
}
