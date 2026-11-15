/**
 * The audio index (D-24, D-28): `audio_recording` rows in their own small SQLite file
 * (`<userData>/audio-index.sqlite`, next to the `audio/` folder), shared by every account on this Mac and
 * **never wiped** — unlike the per-user cache, its rows can't be rebuilt from the server (parts, offsets).
 * A corrupt file is moved aside (`*.corrupt-<time>`), never deleted; transient errors (busy, disk full…)
 * throw `LocalStoreUnavailableError` and leave the file alone; a failing migration throws.
 */
import { renameSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  AudioRecording,
  AudioRecordingFilter,
  AudioRecordingPatch,
  AudioRecordingStore,
} from '@oat/audio';

import { AUDIO_MIGRATIONS } from './migrations.ts';
import { isCorruption, LocalStoreUnavailableError, type OpenLogger } from './open.ts';
import type {
  RecordingRecovery,
  TranscriptJob,
  TranscriptJobFilter,
  TranscriptJobPatch,
  TranscriptJobStore,
} from './transcript-jobs.ts';

type Row = Record<string, SQLInputValue>;

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5_000 });
  try {
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
    if (check?.quick_check !== 'ok') {
      throw Object.assign(new Error(`quick_check: ${check?.quick_check}`), { errcode: 11 });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class AudioIndex implements AudioRecordingStore, TranscriptJobStore {
  readonly #db: DatabaseSync;
  /** Where a corrupt file was moved, if it was. */
  readonly movedAside: string | null;

  constructor(options: { path: string; log?: OpenLogger; now?: () => number }) {
    const { path, log } = options;
    let moved: string | null = null;
    let db: DatabaseSync;
    try {
      db = connect(path);
    } catch (error) {
      if (!isCorruption(error) || path === ':memory:') {
        throw new LocalStoreUnavailableError(`Can't open the audio index ${path}`, error);
      }
      moved = `${path}.corrupt-${(options.now ?? Date.now)()}`;
      log?.error(`audio-index: ${path} is corrupt; moved to ${moved}`, error);
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          renameSync(`${path}${suffix}`, `${moved}${suffix}`);
        } catch {
          /* companion file absent */
        }
      }
      try {
        db = connect(path);
      } catch (again) {
        throw new LocalStoreUnavailableError(`Can't open the audio index ${path}`, again);
      }
    }
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    for (let v = version; v < AUDIO_MIGRATIONS.length; v++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(AUDIO_MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.close();
        throw new LocalStoreUnavailableError(`Can't migrate the audio index ${path}`, error);
      }
    }
    this.#db = db;
    this.movedAside = moved;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  async insert(r: AudioRecording): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO audio_recording (id, meeting_id, source, part, offset_ms, path, codec, sample_rate, started_at, duration_ms, bytes, status, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.meetingId,
        r.source,
        r.part,
        r.offsetMs,
        r.path,
        r.codec,
        r.sampleRate,
        r.startedAt,
        r.durationMs,
        r.bytes,
        r.status,
        r.userId ?? null,
      );
  }

  async update(id: string, patch: AudioRecordingPatch): Promise<AudioRecording> {
    const current = await this.get(id);
    if (!current) throw new Error(`audio_recording ${id} not found`);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as AudioRecording;
    this.#db
      .prepare(
        'UPDATE audio_recording SET part = ?, path = ?, duration_ms = ?, bytes = ?, status = ?, user_id = ? WHERE id = ?',
      )
      .run(next.part, next.path, next.durationMs, next.bytes, next.status, next.userId ?? null, id);
    return next;
  }

  async get(id: string): Promise<AudioRecording | undefined> {
    const r = this.#get('SELECT * FROM audio_recording WHERE id = ?', id);
    return r && toAudio(r);
  }

  async list(filter: AudioRecordingFilter = {}): Promise<AudioRecording[]> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.meetingId !== undefined) {
      where.push('meeting_id = ?');
      params.push(filter.meetingId);
    }
    if (filter.status !== undefined) {
      const statuses = typeof filter.status === 'string' ? [filter.status] : [...filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ') || 'NULL'})`);
      params.push(...statuses);
    }
    if (filter.userId === null) {
      where.push('user_id IS NULL');
    } else if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    return (
      this.#db
        .prepare(
          `SELECT * FROM audio_recording ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY started_at, part, source`,
        )
        .all(...params) as Row[]
    ).map(toAudio);
  }

  // --- transcript back-fill jobs + crash recoveries (2.7, `TranscriptJobStore`) ------------------------

  insertJob(j: TranscriptJob): void {
    this.#db
      .prepare(
        `INSERT INTO stt_backfill (id, meeting_id, user_id, source, start_ms, end_ms, done_ms, reason, status,
           attempts, next_at, segments, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        j.id,
        j.meetingId,
        j.userId,
        j.source,
        j.startMs,
        j.endMs,
        j.doneMs,
        j.reason,
        j.status,
        j.attempts,
        j.nextAt,
        j.segments,
        j.error,
        j.createdAt,
        j.updatedAt,
      );
  }

  updateJob(id: string, patch: TranscriptJobPatch): TranscriptJob {
    const row = this.#get('SELECT * FROM stt_backfill WHERE id = ?', id);
    if (!row) throw new Error(`stt_backfill ${id} not found`);
    const next = {
      ...toJob(row),
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as TranscriptJob;
    this.#db
      .prepare(
        `UPDATE stt_backfill SET done_ms = ?, status = ?, attempts = ?, next_at = ?, segments = ?, error = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        next.doneMs,
        next.status,
        next.attempts,
        next.nextAt,
        next.segments,
        next.error,
        next.updatedAt,
        id,
      );
    return next;
  }

  jobs(filter: TranscriptJobFilter = {}): TranscriptJob[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.meetingId !== undefined) {
      where.push('meeting_id = ?');
      params.push(filter.meetingId);
    }
    if (filter.status !== undefined) {
      const statuses = typeof filter.status === 'string' ? [filter.status] : [...filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ') || 'NULL'})`);
      params.push(...statuses);
    }
    if (filter.userId === null) {
      where.push('user_id IS NULL');
    } else if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    return (
      this.#db
        .prepare(
          `SELECT * FROM stt_backfill ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at, start_ms`,
        )
        .all(...params) as Row[]
    ).map(toJob);
  }

  insertRecovery(r: RecordingRecovery): void {
    this.#db
      .prepare(
        `INSERT INTO recording_recovery (id, meeting_id, user_id, recovered_at, saved_until, parts, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.meetingId,
        r.userId,
        r.recoveredAt,
        r.savedUntil,
        JSON.stringify(r.parts),
        r.appliedAt,
      );
  }

  markRecoveryApplied(id: string, at: number, claimFor?: string): void {
    this.#db
      .prepare(
        'UPDATE recording_recovery SET applied_at = ?, user_id = COALESCE(user_id, ?) WHERE id = ?',
      )
      .run(at, claimFor ?? null, id);
  }

  recoveries(
    filter: { meetingId?: string; userId?: string | null; applied?: boolean } = {},
  ): RecordingRecovery[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.meetingId !== undefined) {
      where.push('meeting_id = ?');
      params.push(filter.meetingId);
    }
    if (filter.userId === null) {
      where.push('user_id IS NULL');
    } else if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.applied !== undefined) {
      where.push(filter.applied ? 'applied_at IS NOT NULL' : 'applied_at IS NULL');
    }
    return (
      this.#db
        .prepare(
          `SELECT * FROM recording_recovery ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY recovered_at DESC`,
        )
        .all(...params) as Row[]
    ).map((r) => ({
      id: String(r.id),
      meetingId: String(r.meeting_id),
      userId: nullableString(r.user_id),
      recoveredAt: Number(r.recovered_at),
      savedUntil: Number(r.saved_until),
      parts: JSON.parse(String(r.parts)) as RecordingRecovery['parts'],
      appliedAt: r.applied_at === null || r.applied_at === undefined ? null : Number(r.applied_at),
    }));
  }
}

const nullableString = (v: SQLInputValue | undefined) =>
  v === null || v === undefined ? null : String(v);

function toJob(r: Row): TranscriptJob {
  return {
    id: String(r.id),
    meetingId: String(r.meeting_id),
    userId: nullableString(r.user_id),
    source: r.source as TranscriptJob['source'],
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    doneMs: Number(r.done_ms),
    reason: r.reason as TranscriptJob['reason'],
    status: r.status as TranscriptJob['status'],
    attempts: Number(r.attempts),
    nextAt: Number(r.next_at),
    segments: Number(r.segments),
    error: nullableString(r.error),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toAudio(r: Row): AudioRecording {
  return {
    id: String(r.id),
    meetingId: String(r.meeting_id),
    source: r.source as AudioRecording['source'],
    part: Number(r.part),
    offsetMs: Number(r.offset_ms),
    path: String(r.path),
    codec: 'opus',
    sampleRate: Number(r.sample_rate),
    startedAt: Number(r.started_at),
    durationMs: Number(r.duration_ms),
    bytes: Number(r.bytes),
    status: r.status as AudioRecording['status'],
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
  };
}
