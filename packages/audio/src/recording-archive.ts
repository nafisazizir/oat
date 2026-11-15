/**
 * Wires the local audio archive (task 2.8, D-10, D-24) to a `RecordingController`: per recording session
 * ("part") one `OpusArchiveWriter` per source at `<base>/audio/<meeting_id>/{mic,system}[.<part>].opus` and one
 * `audio_recording` row each. Node only.
 *
 * Clock: within a session both files start at the `started` event's `tUs` (session time 0), so mic, system and
 * transcript segments share one timeline. Across sessions the caller supplies `offsetMs` — where this session
 * starts on the meeting clock (the clock transcript segment times use) — and it is stored on the rows, so
 * meeting time `t` is at `t − offsetMs` in that part (`locateMeetingTime`, `readMeetingRange`).
 *
 * Failures never stop the recording: a file that cannot be created marks its row `failed`; a disk error while
 * writing (ENOSPC, EIO) is reported once, that source's file is finished as `partial` with everything written
 * so far, and the other source carries on.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { repairOpusFile } from './archive-recovery.ts';
import { nextPart, type AudioRecording, type AudioRecordingStore } from './audio-recording.ts';
import { OpusArchiveWriter, type OpusArchiveWriterOptions } from './opus-archive.ts';
import type { FrameSubscription, RecordingController } from './recording-controller.ts';
import type { AudioEvent, AudioFrame, AudioSourceKind, Unsubscribe } from './types.ts';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Part numbers tried past an unexpected existing file before giving up. */
const MAX_PART_RETRIES = 100;

/**
 * `<baseDir>/audio/<meetingId>/<source>.opus` for part 1, `<source>.<part>.opus` for later parts (D-24).
 * `meetingId` must be a plain id (no separators or dots).
 */
export function audioArchivePath(
  baseDir: string,
  meetingId: string,
  source: AudioSourceKind,
  part = 1,
): string {
  if (!SAFE_SEGMENT.test(meetingId)) {
    throw new RangeError(`unsafe meeting id for a path: ${meetingId}`);
  }
  if (!Number.isInteger(part) || part < 1) throw new RangeError(`invalid part ${part}`);
  return join(
    baseDir,
    'audio',
    meetingId,
    part === 1 ? `${source}.opus` : `${source}.${part}.opus`,
  );
}

/**
 * Oat's per-user data directory: `~/Library/Application Support/Oat` on macOS (what Electron's
 * `app.getPath('userData')` gives for productName Oat), `%APPDATA%\Oat` on Windows, else
 * `$XDG_DATA_HOME/Oat` (default `~/.local/share/Oat`). The desktop app should pass its own `userData`.
 */
export function defaultOatDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Oat');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Oat');
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'Oat');
}

export type ArchiveWriterTuning = Pick<
  OpusArchiveWriterOptions,
  'bitrate' | 'frameMs' | 'pageMs' | 'fsyncMs' | 'openFile'
>;

export type ArchiveErrorCode =
  /** A file could not be created; its row is `failed`. */
  | 'archive_open_failed'
  /** Writing or flushing failed (disk full, I/O error); that source's file was finished as `partial`. */
  | 'archive_write_failed'
  /** Finishing a file failed; it was repaired as `partial` (or left `recording` for startup recovery). */
  | 'archive_close_failed'
  /** Reading/writing `audio_recording` rows failed. */
  | 'archive_store_failed';

/** Reported through `RecordingArchiveOptions.onError`; at most one write failure per source and session. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
  readonly code: ArchiveErrorCode;
  readonly source: AudioSourceKind | undefined;
  readonly recordingId: string | undefined;
  readonly path: string | undefined;

  constructor(
    code: ArchiveErrorCode,
    message: string,
    details: {
      source?: AudioSourceKind;
      recordingId?: string;
      path?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.source = details.source;
    this.recordingId = details.recordingId;
    this.path = details.path;
  }
}

export interface RecordingArchiveOptions {
  controller: RecordingController;
  store: AudioRecordingStore;
  /** Data directory (desktop: `app.getPath('userData')`); files go under `<baseDir>/audio/`. */
  baseDir: string;
  meetingId: string;
  /**
   * Where this session starts on the meeting clock, in ms (0 for the meeting's first recording; for a
   * resumed meeting, the meeting-clock time its transcript segments continue from).
   */
  offsetMs: number;
  writer?: ArchiveWriterTuning;
  /**
   * Frames queued for the archive before its oldest are dropped (a gap, filled with silence). Default 3000
   * (≈ 60 s at 20 ms × 2 sources).
   */
  maxQueuedFrames?: number;
  /** Wall clock for `startedAt`. Default `Date.now`. */
  now?: () => number;
  newId?: () => string;
  /** Archive failures. The recording itself carries on. Default `console.error`. */
  onError?: (error: ArchiveError) => void;
}

interface Entry {
  readonly source: AudioSourceKind;
  readonly id: string;
  readonly path: string;
  readonly writer: OpusArchiveWriter;
  failed: boolean;
  /** Set once the writer failed: finishing the file as `partial`. */
  salvage?: Promise<AudioRecording | undefined>;
}

/**
 * Archives the controller's next recording session (one session per instance). Attach before `start()`.
 * Writers open on `started` (as part `nextPart(rows of the meeting)`), pages are flushed on `paused`, files
 * are finalised on `stopped`.
 */
export class RecordingArchive {
  readonly #options: RecordingArchiveOptions;
  readonly #onError: (error: ArchiveError) => void;
  readonly #entries = new Map<AudioSourceKind, Entry>();
  readonly #offEvent: Unsubscribe;
  readonly #subscription: FrameSubscription;
  #ready: Promise<void> | undefined;
  #started = false;
  #finished: Promise<AudioRecording[]> | undefined;
  #resolveDone!: (recordings: AudioRecording[]) => void;
  readonly #done: Promise<AudioRecording[]>;

  constructor(options: RecordingArchiveOptions) {
    audioArchivePath(options.baseDir, options.meetingId, 'mic'); // validate early
    if (!(options.offsetMs >= 0)) throw new RangeError('offsetMs must be ≥ 0');
    this.#options = options;
    this.#onError = options.onError ?? ((error) => console.error('[audio-archive]', error));
    this.#done = new Promise((resolve) => (this.#resolveDone = resolve));
    this.#offEvent = options.controller.onEvent((event) => this.#onEvent(event));
    this.#subscription = options.controller.subscribe((frame) => this.#onFrame(frame), {
      name: 'audio-archive',
      maxQueuedFrames: options.maxQueuedFrames ?? 3000,
    });
  }

  /**
   * Frames this archive lost because it fell behind (its queue overflowed). Each loss shows up in the file as
   * silence at the right place, never as a timeline shift.
   */
  get droppedFrames(): number {
    return this.#subscription.stats.dropped;
  }

  /** Resolves with the final rows once the recording has stopped and every file is closed. */
  done(): Promise<AudioRecording[]> {
    return this.#done;
  }

  /** Stops archiving now (closing files cleanly). Resolves with the final rows. */
  detach(): Promise<AudioRecording[]> {
    return this.#finish();
  }

  #onEvent(event: AudioEvent): void {
    switch (event.type) {
      case 'started':
        if (this.#started) return;
        this.#started = true;
        this.#ready = this.#open(event.tUs, event.sampleRate, event.sources).catch(
          (error: unknown) =>
            this.#onError(
              new ArchiveError(
                'archive_store_failed',
                `could not start archive: ${message(error)}`,
                {
                  cause: error,
                },
              ),
            ),
        );
        break;
      case 'paused':
        void this.#flush();
        break;
      case 'stopped':
        void this.#finish();
        break;
    }
  }

  async #open(originUs: number, sampleRate: number, sources: readonly AudioSourceKind[]) {
    const { store, meetingId } = this.#options;
    const part = nextPart(await store.list({ meetingId }));
    const startedAt = (this.#options.now ?? Date.now)();
    // Each source on its own: one failing (reported) never stops the other.
    const results = await Promise.allSettled(
      sources.map((source) => this.#openSource(source, part, originUs, sampleRate, startedAt)),
    );
    for (const r of results) {
      if (r.status === 'rejected') this.#onError(r.reason as ArchiveError);
    }
  }

  async #openSource(
    source: AudioSourceKind,
    firstPart: number,
    originUs: number,
    sampleRate: number,
    startedAt: number,
  ): Promise<void> {
    const { store, baseDir, meetingId, offsetMs } = this.#options;
    const id = (this.#options.newId ?? randomUUID)();
    let part = firstPart;
    let path = audioArchivePath(baseDir, meetingId, source, part);
    // Row first: a crash right after creating the file still leaves a row for recovery to find.
    await store.insert({
      id,
      meetingId,
      source,
      part,
      offsetMs,
      path,
      codec: 'opus',
      sampleRate,
      startedAt,
      durationMs: 0,
      bytes: 0,
      status: 'recording',
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const writer = await OpusArchiveWriter.open({
          ...this.#options.writer,
          path,
          originUs,
          sampleRate,
          source,
          comments: {
            OAT_MEETING_ID: meetingId,
            OAT_PART: String(part),
            OAT_OFFSET_MS: String(offsetMs),
          },
        });
        this.#entries.set(source, { source, id, path, writer, failed: false });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < MAX_PART_RETRIES) {
          // A file without a row (e.g. restored from a backup): never overwrite it, take the next part.
          part++;
          path = audioArchivePath(baseDir, meetingId, source, part);
          await store.update(id, { part, path });
          continue;
        }
        await store.update(id, { status: 'failed' }).catch(() => undefined);
        throw new ArchiveError('archive_open_failed', `cannot create ${path}: ${message(error)}`, {
          source,
          recordingId: id,
          path,
          cause: error,
        });
      }
    }
  }

  async #onFrame(frame: AudioFrame): Promise<void> {
    await this.#ready;
    const entry = this.#entries.get(frame.source);
    if (!entry || entry.failed || entry.writer.closed) return;
    try {
      await entry.writer.write(frame);
    } catch (error) {
      this.#fail(entry, 'archive_write_failed', error);
    }
  }

  async #flush(): Promise<void> {
    await this.#subscription.drained();
    await this.#ready;
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        if (entry.failed || entry.writer.closed) return;
        try {
          await entry.writer.flush();
        } catch (error) {
          this.#fail(entry, 'archive_write_failed', error);
        }
      }),
    );
  }

  /** Reports once, stops writing this source and finishes its file as `partial` in the background. */
  #fail(entry: Entry, code: ArchiveErrorCode, error: unknown): void {
    if (entry.failed) return;
    entry.failed = true;
    this.#onError(
      new ArchiveError(code, `${entry.source} archive ${entry.path}: ${message(error)}`, {
        source: entry.source,
        recordingId: entry.id,
        path: entry.path,
        cause: error,
      }),
    );
    entry.salvage = this.#salvage(entry);
  }

  async #salvage(entry: Entry): Promise<AudioRecording | undefined> {
    const { store } = this.#options;
    try {
      await entry.writer.abandon();
      const repair = await repairOpusFile(entry.path);
      return await store.update(entry.id, {
        status: repair.playable ? 'partial' : 'failed',
        durationMs: Math.round(repair.durationMs),
        bytes: repair.bytes,
      });
    } catch (error) {
      // Row stays `recording`: startup recovery (`recoverRecordings`) finishes the file later.
      this.#onError(
        new ArchiveError(
          'archive_store_failed',
          `could not finish ${entry.path}: ${message(error)}`,
          {
            source: entry.source,
            recordingId: entry.id,
            path: entry.path,
            cause: error,
          },
        ),
      );
      return store.get(entry.id).catch(() => undefined);
    }
  }

  #finish(): Promise<AudioRecording[]> {
    this.#finished ??= (async () => {
      this.#offEvent();
      await this.#subscription.drained();
      this.#subscription.unsubscribe();
      await this.#ready;
      const rows = await Promise.all(
        [...this.#entries.values()].map(async (entry) => {
          if (!entry.failed) {
            try {
              const stats = await entry.writer.close();
              return await this.#options.store.update(entry.id, {
                status: 'complete',
                durationMs: Math.round(stats.durationMs),
                bytes: stats.bytes,
              });
            } catch (error) {
              // A background page write that failed surfaces here when nothing was written after it.
              const code = entry.writer.failed ? 'archive_write_failed' : 'archive_close_failed';
              this.#fail(entry, code, error);
            }
          }
          return entry.salvage;
        }),
      );
      const recordings = rows
        .filter((r): r is AudioRecording => r !== undefined)
        .sort((a, b) => a.source.localeCompare(b.source));
      this.#resolveDone(recordings);
      return recordings;
    })();
    return this.#finished;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
