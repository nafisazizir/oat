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

export class AudioIndex implements AudioRecordingStore {
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
        `INSERT INTO audio_recording (id, meeting_id, source, part, offset_ms, path, codec, sample_rate, started_at, duration_ms, bytes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        'UPDATE audio_recording SET part = ?, path = ?, duration_ms = ?, bytes = ?, status = ? WHERE id = ?',
      )
      .run(next.part, next.path, next.durationMs, next.bytes, next.status, id);
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
    return (
      this.#db
        .prepare(
          `SELECT * FROM audio_recording ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY started_at, part, source`,
        )
        .all(...params) as Row[]
    ).map(toAudio);
  }
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
  };
}
