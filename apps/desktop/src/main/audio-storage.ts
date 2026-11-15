/**
 * Local audio archive storage (task 3.8, D-10, D-24, D-28, D-30): usage per meeting, "Delete audio", "Show in
 * Finder", the retention policy and the sweeper that enforces it. Electron-free (Finder is injected), so the
 * safety rules are unit-tested against real temp folders.
 *
 * Accounts (D-30): every `audio_recording` row names the account that recorded it. The list, delete, Finder,
 * the policy and the sweeper act only on the **signed-in account's** rows; other accounts' audio (and old rows
 * no account has claimed) is only an aggregate. Rows from before D-30 have no account: the account whose local
 * database owns the meeting's note claims them the first time it looks; nobody else ever does.
 *
 * Safety rules (whatever the caller asks):
 * - Only `.opus` files that an `audio_recording` row names **and** that sit directly in
 *   `<baseDir>/audio/<meetingId>/` (resolved, no symlinked file or folder; re-checked right before each
 *   unlink) are ever removed; a row whose path points anywhere else is left alone and logged. The meeting
 *   folder is removed only when empty.
 * - Transcripts and notes are never touched: this module doesn't get the local store, only a lookup for
 *   titles/ownership.
 * - The meeting in use by the recorder (starting, recording, closing files) can't be deleted by the user or the
 *   sweeper; it is re-checked before every file. The sweeper also never deletes audio with activity in the last
 *   hour (`retention.ts`).
 * - Rows are kept as `deleted` (bytes 0) so the meeting view can say "Audio deleted" (D-24: they also keep
 *   part numbers unique for a later resumed session).
 * - One mutation at a time: deletes, sweeps and settings writes go through one queue; a settings change
 *   becomes live only once it is on disk.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { AudioRecording, AudioRecordingStore } from '@oat/audio';
import {
  type AudioAvailability,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type RetentionPreview,
  retentionPolicySchema,
  STORAGE_LIST_MAX,
  STORAGE_TITLE_MAX,
  type StorageMeeting,
  type StorageSummary,
  type SweepResult,
  sweepResultSchema,
} from '@oat/core/bridge';
import { z } from 'zod';

import type { Logger } from './ipc.ts';
import { isProtected, type MeetingUsage, planRetention } from './retention.ts';

/** The sweeper runs on launch/sign-in, after every recording and every 6 h. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SAFE_MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** `mic.opus`, `system.opus`, `mic.2.opus`… (`audioArchivePath`, D-24). */
const ARCHIVE_FILE = /^(?:mic|system)(?:\.[1-9][0-9]{0,5})?\.opus$/;

/** The archive root: `<baseDir>/audio`. */
export function audioRoot(baseDir: string): string {
  return resolve(baseDir, 'audio');
}

/** `<root>/<meetingId>`, or `null` if the id could escape the root (separators, dots, empty). */
export function meetingFolder(root: string, meetingId: string): string | null {
  if (!SAFE_MEETING_ID.test(meetingId)) return null;
  const folder = resolve(root, meetingId);
  return dirname(folder) === resolve(root) ? folder : null;
}

/**
 * The resolved path if `path` is one of this meeting's archive files (lexically: directly inside its
 * folder, archive file name), else `null`. The filesystem checks (no symlinks) happen at deletion.
 */
export function archiveFilePath(root: string, meetingId: string, path: string): string | null {
  const folder = meetingFolder(root, meetingId);
  if (!folder) return null;
  const file = resolve(path);
  if (dirname(file) !== folder || !ARCHIVE_FILE.test(basename(file))) return null;
  return file;
}

/** A title for the bridge: at most `STORAGE_TITLE_MAX` UTF-16 units (synced titles may be longer). */
export function clampTitle(title: string): string {
  if (title.length <= STORAGE_TITLE_MAX) return title;
  let cut = title.slice(0, STORAGE_TITLE_MAX - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never split a surrogate pair
  return `${cut}…`;
}

/** Thrown for requests that can't be served now; `code` is a bridge error code. */
export class StorageError extends Error {
  override name = 'StorageError';
  constructor(
    readonly code: 'invalid_state' | 'invalid_payload' | 'unauthorized',
    message: string,
  ) {
    super(message);
  }
}

export interface MeetingInfo {
  /** The note's title, if this account has it. */
  title: string | null;
  /** The meeting was recorded (somewhere): it has a start time. */
  recorded: boolean;
  /** This account owns the meeting's note (it recorded it): may claim the meeting's unattributed rows. */
  owned: boolean;
}

export interface AudioStorageOptions {
  /** The app's data folder (`userData`); audio lives in `<baseDir>/audio/`. */
  baseDir: string;
  /** The audio index (D-28). */
  store: AudioRecordingStore;
  /** Where each account's policy and last sweep are kept (`<userData>/audio-retention.json`). */
  settingsFile: string;
  /** The signed-in account whose local database is open, or `null`. */
  currentUser: () => string | null;
  /** The meeting in use by the recorder (starting, recording, files closing), if any. */
  activeMeeting: () => string | null;
  /** What the signed-in account knows about a meeting (`null`: not in this account). */
  meetingInfo: (meetingId: string) => MeetingInfo | null;
  /** `shell.showItemInFolder`. */
  reveal: (path: string) => void;
  /** The archive changed (files deleted, policy saved, a recording ended, the account changed). */
  onChanged?: () => void;
  log: Logger;
  now?: () => number;
  intervalMs?: number;
}

interface FileInfo {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

interface MeetingAudio {
  readonly meetingId: string;
  /** Rows with (possibly) a file: not `deleted`, not `failed`. */
  readonly live: AudioRecording[];
  readonly deletedRows: number;
  readonly files: Map<string, FileInfo>;
  readonly usage: MeetingUsage;
  readonly durationMs: number;
  readonly parts: number;
  readonly partial: boolean;
}

interface Scan {
  /** The signed-in account's meetings. */
  mine: Map<string, MeetingAudio>;
  /** Everyone else's (and unclaimed) audio that still has files. */
  others: { meetings: number; bytes: number };
}

const accountSettingsSchema = z.object({
  policy: retentionPolicySchema,
  lastSweep: sweepResultSchema.nullable().default(null),
});
type AccountSettings = z.infer<typeof accountSettingsSchema>;
const settingsSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string(), accountSettingsSchema),
});
type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_ACCOUNT: AccountSettings = { policy: DEFAULT_RETENTION_POLICY, lastSweep: null };

/** `AudioStorage.playable`: availability + this account's validated rows with a file (3.7). */
export interface PlayableAudio {
  availability: AudioAvailability;
  recordings: AudioRecording[];
}

export class AudioStorage {
  readonly #o: AudioStorageOptions;
  readonly #root: string;
  readonly #now: () => number;
  #settings: Settings;
  /** Serialises deletes, sweeps and settings writes. */
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AudioStorageOptions) {
    this.#o = options;
    this.#root = audioRoot(options.baseDir);
    this.#now = options.now ?? Date.now;
    this.#settings = this.#load();
  }

  /** The signed-in account's policy (keep forever when signed out or never set). */
  get policy(): RetentionPolicy {
    return this.#account().policy;
  }

  /** Sweeps now (launch) and every `intervalMs` (6 h). */
  start(): void {
    if (this.#timer) return;
    void this.sweep('launch');
    this.#timer = setInterval(
      () => void this.sweep('interval'),
      this.#o.intervalMs ?? SWEEP_INTERVAL_MS,
    );
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** A recording ended: sizes changed, and the cap may now be exceeded. */
  recordingEnded(): void {
    this.#o.onChanged?.();
    void this.sweep('recording');
  }

  /** Another account signed in (or out): its audio, its policy. */
  accountChanged(): void {
    this.#o.onChanged?.();
    if (this.#o.currentUser()) void this.sweep('sign-in');
  }

  async summary(): Promise<StorageSummary> {
    const { mine, others } = await this.#scan();
    const active = this.#o.activeMeeting();
    const list: StorageMeeting[] = [];
    let deletedMeetings = 0;
    let totalBytes = 0;
    for (const m of mine.values()) {
      totalBytes += m.usage.bytes;
      if (!hasAudio(m)) {
        if (m.deletedRows > 0) deletedMeetings++;
        continue;
      }
      const recording = m.meetingId === active;
      const title = this.#info(m.meetingId)?.title;
      list.push({
        meetingId: m.meetingId,
        title: title ? clampTitle(title) : null,
        startedAt: m.usage.startedAt,
        lastActivityAt: m.usage.lastActivityAt,
        bytes: m.usage.bytes,
        durationMs: m.durationMs,
        parts: m.parts,
        status: recording ? 'recording' : m.partial ? 'partial' : 'complete',
        deletable: !recording,
      });
    }
    list.sort((a, b) => b.startedAt - a.startedAt);
    const account = this.#account();
    return {
      totalBytes,
      meetings: list.slice(0, STORAGE_LIST_MAX),
      meetingCount: list.length,
      deletedMeetings,
      otherAccounts: others,
      policy: account.policy,
      lastSweep: account.lastSweep,
    };
  }

  /** Deletes every audio file of one of the signed-in account's meetings (never while it is in use). */
  deleteAudio(
    meetingId: string,
  ): Promise<{ deleted: boolean; freedBytes: number; alreadyGone: boolean }> {
    return this.#serial(async () => {
      if (!meetingFolder(this.#root, meetingId)) {
        throw new StorageError('invalid_payload', 'Unknown meeting.');
      }
      if (!this.#o.currentUser()) throw new StorageError('unauthorized', 'Sign in first.');
      if (this.#o.activeMeeting() === meetingId) {
        throw new StorageError(
          'invalid_state',
          'This meeting is being recorded. Stop the recording before deleting its audio.',
        );
      }
      const meeting = (await this.#scan(meetingId)).mine.get(meetingId);
      if (!meeting || !hasAudio(meeting)) {
        // Nothing of this account's left (a sweep got there first, or it isn't ours): tidy rows only.
        if (meeting?.live.length) await this.#deleteMeeting(meeting);
        return { deleted: false, freedBytes: 0, alreadyGone: true };
      }
      const result = await this.#deleteMeeting(meeting);
      this.#o.log.info(
        `storage: deleted the audio of ${meetingId} (${result.freedBytes} bytes, by the user)`,
      );
      this.#o.onChanged?.();
      return { deleted: result.ok, freedBytes: result.freedBytes, alreadyGone: false };
    });
  }

  /** Reveals the folder of one of the signed-in account's meetings (validated: inside the audio root). */
  async show(meetingId: string): Promise<{ shown: boolean }> {
    const folder = meetingFolder(this.#root, meetingId);
    if (!folder) throw new StorageError('invalid_payload', 'Unknown meeting.');
    const meeting = (await this.#scan(meetingId)).mine.get(meetingId);
    if (!meeting || !hasAudio(meeting) || !(await this.#isRealFolder(folder))) {
      return { shown: false };
    }
    this.#o.reveal(folder);
    return { shown: true };
  }

  /** Dry run of a policy for the signed-in account, with the sweeper's safety rules. */
  async preview(policy: RetentionPolicy): Promise<RetentionPreview> {
    if (!this.#o.currentUser()) {
      return { meetings: 0, bytes: 0, meetingIds: [], overCapAfter: false };
    }
    const plan = planRetention(this.#usages((await this.#scan()).mine), policy, this.#now());
    return {
      meetings: plan.meetingIds.length,
      bytes: plan.bytes,
      meetingIds: plan.meetingIds.slice(0, STORAGE_LIST_MAX),
      overCapAfter: plan.overCapAfter,
    };
  }

  /**
   * Saves the signed-in account's policy (live only once it is on disk), applies it right away and returns
   * the new summary.
   */
  async setPolicy(policy: RetentionPolicy): Promise<StorageSummary> {
    const parsed = retentionPolicySchema.parse(policy);
    await this.#serial(async () => {
      const user = this.#o.currentUser();
      if (!user) throw new StorageError('unauthorized', 'Sign in first.');
      await this.#commit(user, { policy: parsed });
      this.#o.log.info(`storage: retention policy ${JSON.stringify(parsed)}`);
    });
    await this.sweep('policy');
    this.#o.onChanged?.();
    return this.summary();
  }

  /** Read-only hint for the meeting view / playback (3.7), from the signed-in account's point of view. */
  async audioStatus(meetingId: string): Promise<AudioAvailability> {
    if (!meetingFolder(this.#root, meetingId)) {
      throw new StorageError('invalid_payload', 'Unknown meeting.');
    }
    const meeting = (await this.#scan(meetingId)).mine.get(meetingId);
    const base = { meetingId, bytes: meeting?.usage.bytes ?? 0, parts: meeting?.parts ?? 0 };
    if (this.#o.activeMeeting() === meetingId) return { ...base, status: 'recording' };
    if (meeting && hasAudio(meeting)) return { ...base, status: 'available' };
    // Rows that were deleted, or whose files are gone (removed outside the app).
    if (meeting && (meeting.deletedRows > 0 || meeting.live.length > 0)) {
      return { ...base, status: 'deleted' };
    }
    // Recorded, but no row of this account here (only failed rows count as "none").
    if (!meeting && this.#info(meetingId)?.recorded) return { ...base, status: 'other-device' };
    return { ...base, status: 'none' };
  }

  /**
   * The signed-in account's audio of one meeting for playback (3.7): its availability and, when `available`,
   * the rows whose file is an archive file directly inside the meeting's real folder (no symlinked folder;
   * the reader opens each file with `O_NOFOLLOW`). Paths are the resolved, validated ones. Other accounts'
   * rows are never returned (D-30).
   */
  async playable(meetingId: string): Promise<PlayableAudio> {
    const availability = await this.audioStatus(meetingId);
    if (availability.status !== 'available') return { availability, recordings: [] };
    const folder = meetingFolder(this.#root, meetingId)!;
    const meeting = (await this.#scan(meetingId)).mine.get(meetingId);
    if (!meeting || !(await this.#isRealFolder(folder))) {
      this.#o.log.warn(`storage: ${meetingId}: audio folder is not inside the audio root`);
      return { availability, recordings: [] };
    }
    const recordings: AudioRecording[] = [];
    for (const row of meeting.live) {
      const path = archiveFilePath(this.#root, meetingId, row.path);
      if (path && meeting.files.get(row.id)?.exists) recordings.push({ ...row, path });
    }
    return { availability, recordings };
  }

  /**
   * Applies the signed-in account's policy to its audio now. Never throws (the sweeper runs unattended);
   * failures are logged. Signed out: nothing happens.
   */
  sweep(reason: SweepResult['reason']): Promise<SweepResult> {
    return this.#serial(async () => {
      const user = this.#o.currentUser();
      const policy = user ? this.#account(user).policy : DEFAULT_RETENTION_POLICY;
      if (!user || policy.kind === 'forever') {
        return { at: this.#now(), reason, meetings: 0, freedBytes: 0, skipped: 0 };
      }
      let meetings = 0;
      let freedBytes = 0;
      let skipped = 0;
      try {
        const { mine } = await this.#scan();
        const plan = planRetention(this.#usages(mine), policy, this.#now());
        for (const meetingId of plan.meetingIds) {
          const meeting = mine.get(meetingId)!;
          // Re-checked right before deleting: a recording may have started since the plan.
          if (this.#o.activeMeeting() === meetingId || isProtected(meeting.usage, this.#now())) {
            skipped++;
            continue;
          }
          const result = await this.#deleteMeeting(meeting);
          freedBytes += result.freedBytes;
          if (result.ok) meetings++;
          else skipped++;
        }
      } catch (error) {
        this.#o.log.error(`storage: sweep (${reason}) failed`, error);
      }
      const result: SweepResult = { at: this.#now(), reason, meetings, freedBytes, skipped };
      if (meetings > 0 || skipped > 0) {
        this.#o.log.info(
          `storage: sweep (${reason}, ${policy.kind}) deleted ${meetings} meeting(s), ${freedBytes} bytes, skipped ${skipped}`,
        );
      }
      await this.#commit(user, { lastSweep: result }).catch((error: unknown) =>
        this.#o.log.error('storage: could not save the last sweep', error),
      );
      if (meetings > 0) this.#o.onChanged?.();
      return result;
    });
  }

  // --- internals ---------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #account(user = this.#o.currentUser()): AccountSettings {
    return (user && this.#settings.accounts[user]) || DEFAULT_ACCOUNT;
  }

  #info(meetingId: string): MeetingInfo | null {
    try {
      return this.#o.meetingInfo(meetingId);
    } catch {
      return null; // the account's database is closed or busy: no title, no claim
    }
  }

  #usages(meetings: Map<string, MeetingAudio>): MeetingUsage[] {
    const active = this.#o.activeMeeting();
    return [...meetings.values()]
      .filter((m) => m.live.length > 0)
      .map((m) => ({ ...m.usage, active: m.usage.active || m.meetingId === active }));
  }

  /**
   * The signed-in account's meetings (all, or one) with file sizes from disk, plus an aggregate of everyone
   * else's audio. Unattributed rows of a meeting this account owns are claimed on the way (D-30).
   */
  async #scan(meetingId?: string): Promise<Scan> {
    const user = this.#o.currentUser();
    const rows = await this.#o.store.list(meetingId === undefined ? {} : { meetingId });
    const owned = new Map<string, boolean>();
    const mineRows: AudioRecording[] = [];
    const otherRows: AudioRecording[] = [];
    for (const row of rows) {
      let owner = row.userId ?? null;
      if (owner === null && user) {
        if (!owned.has(row.meetingId)) {
          owned.set(row.meetingId, this.#info(row.meetingId)?.owned === true);
        }
        if (owned.get(row.meetingId)) {
          try {
            await this.#o.store.update(row.id, { userId: user });
            owner = user;
          } catch (error) {
            this.#o.log.error(`storage: could not attribute ${row.id} to this account`, error);
          }
        }
      }
      if (user && owner === user) mineRows.push(row);
      else otherRows.push(row);
    }

    const active = this.#o.activeMeeting();
    const mine = new Map<string, MeetingAudio>();
    for (const [id, all] of groupBy(mineRows)) {
      const live = all.filter((r) => r.status !== 'deleted' && r.status !== 'failed');
      const files = new Map<string, FileInfo>();
      for (const row of live) files.set(row.id, await this.#fileInfo(row));
      let bytes = 0;
      let lastActivityAt = 0;
      let startedAt = Infinity;
      const parts = new Set<number>();
      const partDuration = new Map<number, number>();
      for (const row of live) {
        const file = files.get(row.id)!;
        startedAt = Math.min(startedAt, row.startedAt);
        lastActivityAt = Math.max(lastActivityAt, row.startedAt + row.durationMs);
        if (!file.exists) continue;
        bytes += file.size;
        lastActivityAt = Math.max(lastActivityAt, file.mtimeMs);
        parts.add(row.part);
        partDuration.set(row.part, Math.max(partDuration.get(row.part) ?? 0, row.durationMs));
      }
      let durationMs = 0;
      for (const d of partDuration.values()) durationMs += d;
      mine.set(id, {
        meetingId: id,
        live,
        deletedRows: all.filter((r) => r.status === 'deleted').length,
        files,
        durationMs,
        parts: parts.size,
        // A `recording` row of a meeting that isn't being recorded was left by a crash.
        partial: live.some(
          (r) => r.status === 'partial' || (r.status === 'recording' && id !== active),
        ),
        usage: {
          meetingId: id,
          bytes,
          startedAt: Number.isFinite(startedAt) ? startedAt : 0,
          lastActivityAt,
          active: id === active,
        },
      });
    }

    const others = { meetings: 0, bytes: 0 };
    for (const [, all] of groupBy(otherRows)) {
      let bytes = 0;
      let any = false;
      for (const row of all) {
        if (row.status === 'deleted' || row.status === 'failed') continue;
        const file = await this.#fileInfo(row);
        if (!file.exists) continue;
        any = true;
        bytes += file.size;
      }
      if (any) {
        others.meetings++;
        others.bytes += bytes;
      }
    }
    return { mine, others };
  }

  /** Size and mtime of a row's file; a path outside the meeting's folder counts as no file. */
  async #fileInfo(row: AudioRecording): Promise<FileInfo> {
    const path = archiveFilePath(this.#root, row.meetingId, row.path);
    if (!path) return { exists: false, size: 0, mtimeMs: 0 };
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) return { exists: false, size: 0, mtimeMs: 0 };
      return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
  }

  /** `folder` is a directory (not a symlink) whose real path is inside the real audio root. */
  async #isRealFolder(folder: string): Promise<boolean> {
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory()) return false;
      const [realRoot, realFolder] = await Promise.all([realpath(this.#root), realpath(folder)]);
      return realFolder === join(realRoot, basename(folder));
    } catch {
      return false;
    }
  }

  async #isRealFolderOrMissing(folder: string): Promise<boolean> {
    try {
      await lstat(folder);
    } catch {
      return true;
    }
    return this.#isRealFolder(folder);
  }

  /**
   * Deletes one meeting's live rows' files (this account's rows only: `meeting.live`). Each file is
   * re-validated right before its unlink: the meeting isn't in use, the folder is still a real folder inside
   * the root, the file is a regular file. (A same-user process swapping the folder between that check and the
   * unlink could still redirect one archive-named unlink; Node has no `unlinkat`. Accepted: it needs the
   * user's own privileges, and the name must still match `mic|system[.n].opus`.)
   */
  async #deleteMeeting(meeting: MeetingAudio): Promise<{ ok: boolean; freedBytes: number }> {
    const { meetingId } = meeting;
    const folder = meetingFolder(this.#root, meetingId);
    if (!folder || !(await this.#isRealFolderOrMissing(folder))) {
      this.#o.log.warn(`storage: ${meetingId}: folder is not inside the audio root`);
      return { ok: false, freedBytes: 0 };
    }
    let ok = true;
    let freedBytes = 0;
    for (const row of meeting.live) {
      if (this.#o.activeMeeting() === meetingId) {
        this.#o.log.warn(`storage: ${meetingId} started recording; stopped deleting its audio`);
        return { ok: false, freedBytes };
      }
      const path = archiveFilePath(this.#root, meetingId, row.path);
      if (!path) {
        this.#o.log.warn(`storage: row ${row.id} names a file outside its meeting folder; kept`);
        ok = false;
        continue;
      }
      try {
        if (!(await this.#isRealFolderOrMissing(folder))) {
          this.#o.log.warn(`storage: ${meetingId}: folder changed; kept ${path}`);
          ok = false;
          continue;
        }
        const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (stat && !stat.isFile()) {
          this.#o.log.warn(`storage: ${path} is not a regular file; kept`);
          ok = false;
          continue;
        }
        if (stat) {
          await unlink(path);
          freedBytes += stat.size;
        }
        await this.#o.store.update(row.id, { status: 'deleted', bytes: 0 });
      } catch (error) {
        this.#o.log.error(`storage: could not delete ${path}`, error);
        ok = false;
      }
    }
    // Only an empty folder: files we don't know about (e.g. restored from a backup) stay.
    if (this.#o.activeMeeting() !== meetingId) await rmdir(folder).catch(() => undefined);
    return { ok, freedBytes };
  }

  #load(): Settings {
    let text: string;
    try {
      text = readFileSync(this.#o.settingsFile, 'utf8');
    } catch {
      return { version: 2, accounts: {} };
    }
    try {
      return settingsSchema.parse(JSON.parse(text));
    } catch (error) {
      // Never guess a deleting policy from a damaged file: keep everything.
      this.#o.log.warn(`storage: ignoring unreadable ${this.#o.settingsFile} (${String(error)})`);
      return { version: 2, accounts: {} };
    }
  }

  /** Writes the account's change to disk, then (only then) makes it live. Call inside `#serial`. */
  async #commit(user: string, change: Partial<AccountSettings>): Promise<void> {
    const next: Settings = {
      version: 2,
      accounts: {
        ...this.#settings.accounts,
        [user]: { ...this.#account(user), ...change },
      },
    };
    const file = this.#o.settingsFile;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#settings = next;
  }
}

function hasAudio(meeting: MeetingAudio): boolean {
  return meeting.live.some((r) => meeting.files.get(r.id)?.exists);
}

function groupBy(rows: readonly AudioRecording[]): Map<string, AudioRecording[]> {
  const groups = new Map<string, AudioRecording[]>();
  for (const row of rows) {
    const list = groups.get(row.meetingId);
    if (list) list.push(row);
    else groups.set(row.meetingId, [row]);
  }
  return groups;
}
