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
 * - 3.5: while the engine runs, the SSE invalidation channel (`SyncEventsClient`) is open; each event (and
 *   each reconnect) makes the engine pull now; the engine's 60 s interval is the backstop. Pushes carry
 *   this Mac's name (written on the conflicted copies it creates). Local search and conflicted-copy
 *   resolution read/write the open user's database.
 */
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { ConflictDetailSnapshot, ConflictSummary, SearchHitSnapshot } from '@oat/core/bridge';
import { diffLines, documentLines } from '@oat/core/sync';
import {
  type LocalConflict,
  LocalStore,
  stripConflictSuffix,
  SyncEngine,
  type SyncEngineOptions,
  type SyncStatus,
  type SyncTransport,
} from '@oat/local-store';

import type { Logger } from './ipc.ts';
import { SyncEventsClient, type SyncEventsOptions } from './sync-events.ts';

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
  /** This Mac's name, written on conflicted copies (3.5). */
  deviceName?: string;
  /** Opens the SSE invalidation channel (3.5); without it, only the interval backstop pulls. */
  events?: Pick<SyncEventsOptions, 'connect'> &
    Partial<Omit<SyncEventsOptions, 'connect' | 'onEvent' | 'onOpen'>>;
}

/** Pull backstop while the SSE channel normally carries changes (3.5). */
const BACKSTOP_MS = 60_000;

const STOPPED: SyncStatus = {
  state: 'stopped',
  pending: 0,
  parked: 0,
  lastSyncedAt: null,
  error: null,
};

/** This Mac's name for conflicted copies: the host name without `.local`, dashes as spaces. */
export function deviceName(host: string = hostname()): string {
  return (
    host
      .replace(/\.local$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .slice(0, 100) || 'Mac'
  );
}

/** `oat-<userId>.sqlite` with anything but `[A-Za-z0-9_-]` replaced. */
export function databaseFileFor(userId: string): string {
  return `oat-${userId.replace(/[^A-Za-z0-9_-]/g, '_')}.sqlite`;
}

export class SyncService {
  readonly #o: SyncServiceOptions;
  #store: LocalStore | null = null;
  #storeUser: string | null = null;
  #engine: SyncEngine | null = null;
  #events: SyncEventsClient | null = null;
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
      this.#events?.stop();
      this.#engine?.stop();
      this.#emit(STOPPED);
      return;
    }
    if (wanted === this.#storeUser && this.#engine) {
      this.#engine.start();
      this.#events?.start();
      return;
    }
    if (this.#store && this.#o.isRecording()) {
      this.#o.log.warn('sync: account changed while recording; switching once the recording ends');
      this.#events?.stop();
      this.#engine?.stop();
      this.#applied = undefined;
      return;
    }
    this.#events?.stop();
    this.#events = null;
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
      const open =
        this.#o.openStore ??
        ((p: string) =>
          new LocalStore({
            path: p,
            log: this.#o.log,
            ...(this.#o.deviceName ? { deviceName: this.#o.deviceName } : {}),
          }));
      const store = open(path);
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
      intervalMs: BACKSTOP_MS,
      ...(this.#o.deviceName ? { device: { name: this.#o.deviceName } } : {}),
      ...(this.#o.onUnauthorized ? { onUnauthorized: this.#o.onUnauthorized } : {}),
      ...this.#o.engine,
    });
    this.#engine.start();
    if (this.#o.events) {
      const engine = this.#engine;
      this.#events = new SyncEventsClient({
        log: this.#o.log,
        ...this.#o.events,
        onEvent: () => engine.notify(),
        onOpen: () => engine.notify(),
      });
      this.#events.start();
    }
  }

  /** Whether the SSE channel is connected right now. */
  get live(): boolean {
    return this.#events?.connected ?? false;
  }

  // --- local search + conflicted copies (3.5) -----------------------------------------------------------

  search(query: string): SearchHitSnapshot[] {
    return this.#store?.search(query, { limit: 30 }) ?? [];
  }

  conflicts(): ConflictSummary[] {
    return (this.#store?.conflicts() ?? []).map(summary);
  }

  conflict(copyId: string): ConflictDetailSnapshot | null {
    const c = this.#store?.conflict(copyId);
    if (!c) return null;
    const revision = comparisonRevision(c);
    const copyLines = [stripConflictSuffix(c.copy.title), ...documentLines(c.copy.contentJson)];
    if (!c.original || c.original.deletedAt !== null) {
      return {
        revision,
        summary: summary(c),
        original: null,
        copy: copyLines.map((text) => ({ text, changed: false })),
      };
    }
    const diff = diffLines([c.original.title, ...documentLines(c.original.contentJson)], copyLines);
    return { revision, summary: summary(c), original: diff.left, copy: diff.right };
  }

  /** Resolves a conflicted copy locally; the edit and the copy's delete sync like any change. */
  resolveConflict(copyId: string, keep: 'copy' | 'original', revision: string): boolean {
    const conflict = this.#store?.conflict(copyId);
    if (!conflict || comparisonRevision(conflict) !== revision) return false;
    const done = this.#store?.resolveConflict(copyId, keep) ?? false;
    if (done) this.kick();
    return done;
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
   * Whether the user's workspaces are on this Mac (new notes need one to go to). They are after the first
   * pull; if they aren't yet, keeps syncing (bounded by `timeoutMs`; a pull can come back empty for a
   * moment, D-22). `false` when they still can't be known (offline on a fresh database).
   */
  async awaitWorkspaces(timeoutMs = 10_000): Promise<boolean> {
    await this.#chain;
    const deadline = Date.now() + timeoutMs;
    const known = () => (this.#store?.firstWorkspaceId() ?? null) !== null;
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
    this.#events?.stop();
    this.#engine?.stop();
    await this.#engine?.idle();
    this.#store?.close();
  }
}

function comparisonRevision(conflict: LocalConflict): string {
  return createHash('sha256').update(JSON.stringify(conflict)).digest('hex');
}

function summary({ copy, original }: LocalConflict): ConflictSummary {
  return {
    copyId: copy.id,
    title: copy.title,
    device: copy.conflictDevice,
    at: copy.conflictAt,
    originalId: copy.conflictOfId,
    originalTitle: original && original.deletedAt === null ? original.title : null,
  };
}
