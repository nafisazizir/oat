import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioIndex } from './audio-index.ts';
import { AUDIO_MIGRATIONS } from './migrations.ts';
import { LocalStore } from './store.ts';
import {
  InMemoryTranscriptJobStore,
  type RecordingRecovery,
  type TranscriptJob,
  type TranscriptJobStore,
} from './transcript-jobs.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-transcript-jobs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const job = (patch: Partial<TranscriptJob> = {}): TranscriptJob => ({
  id: 'j1',
  meetingId: 'm1',
  userId: 'u1',
  source: 'mic',
  startMs: 10_000,
  endMs: 190_000,
  doneMs: 10_000,
  reason: 'stt_offline',
  status: 'pending',
  attempts: 0,
  nextAt: 0,
  segments: 0,
  error: null,
  createdAt: 100,
  updatedAt: 100,
  ...patch,
});

const recovery = (patch: Partial<RecordingRecovery> = {}): RecordingRecovery => ({
  id: 'r1',
  meetingId: 'm1',
  userId: 'u1',
  recoveredAt: 5000,
  savedUntil: 4000,
  parts: [{ source: 'mic', part: 1, offsetMs: 0, endMs: 30_000, startedAt: 1000 }],
  appliedAt: null,
  ...patch,
});

describe.each<[string, () => TranscriptJobStore & { close?: () => void }]>([
  ['AudioIndex', () => new AudioIndex({ path: ':memory:' })],
  ['InMemoryTranscriptJobStore', () => new InMemoryTranscriptJobStore()],
])('%s as TranscriptJobStore', (_name, create) => {
  it('inserts, updates and filters jobs', () => {
    const store = create();
    store.insertJob(job());
    expect(() => store.insertJob(job())).toThrow();
    store.insertJob(job({ id: 'j2', source: 'system', createdAt: 200, userId: null }));
    store.insertJob(job({ id: 'j3', meetingId: 'm2', createdAt: 50, status: 'done' }));

    const updated = store.updateJob('j1', {
      doneMs: 70_000,
      segments: 4,
      attempts: 0,
      updatedAt: 300,
      error: undefined,
    });
    expect(updated).toEqual(job({ doneMs: 70_000, segments: 4, updatedAt: 300 }));
    expect(store.jobs({ meetingId: 'm1' })[0]).toEqual(updated);
    expect(store.jobs().map((j) => j.id)).toEqual(['j3', 'j1', 'j2']);
    expect(store.jobs({ status: 'pending' }).map((j) => j.id)).toEqual(['j1', 'j2']);
    expect(store.jobs({ status: ['done', 'failed'] }).map((j) => j.id)).toEqual(['j3']);
    expect(store.jobs({ userId: null }).map((j) => j.id)).toEqual(['j2']);
    expect(store.jobs({ userId: 'u1', meetingId: 'm1' }).map((j) => j.id)).toEqual(['j1']);
    expect(store.updateJob('j2', { status: 'failed', error: 'Audio deleted' })).toMatchObject({
      status: 'failed',
      error: 'Audio deleted',
      source: 'system',
    });
    expect(() => store.updateJob('nope', {})).toThrow(/not found/);
    store.close?.();
  });

  it('keeps recoveries, newest first, and marks them applied', () => {
    const store = create();
    store.insertRecovery(recovery());
    store.insertRecovery(recovery({ id: 'r2', recoveredAt: 9000, userId: 'u2' }));
    expect(store.recoveries().map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(store.recoveries({ meetingId: 'm1', userId: 'u1' })).toEqual([recovery()]);
    store.markRecoveryApplied('r1', 7000);
    expect(store.recoveries({ applied: false }).map((r) => r.id)).toEqual(['r2']);
    expect(store.recoveries({ applied: true })[0]).toMatchObject({ id: 'r1', appliedAt: 7000 });
    store.close?.();
  });
});

describe('AudioIndex migration 3 (2.7)', () => {
  it('adds the job tables to an existing index and keeps its rows', async () => {
    const path = join(dir, 'audio-index.sqlite');
    const old = new DatabaseSync(path);
    old.exec(AUDIO_MIGRATIONS[0]!);
    old.exec(AUDIO_MIGRATIONS[1]!);
    old.exec('PRAGMA user_version = 2');
    old
      .prepare(
        `INSERT INTO audio_recording (id, meeting_id, source, part, offset_ms, path, codec, sample_rate, started_at, duration_ms, bytes, status, user_id)
         VALUES ('a', 'm1', 'mic', 1, 0, '/x', 'opus', 16000, 1, 0, 0, 'recording', 'u1')`,
      )
      .run();
    old.close();
    const index = new AudioIndex({ path });
    expect(await index.get('a')).toMatchObject({ status: 'recording', userId: 'u1' });
    index.insertJob(job());
    index.close();
    // Jobs survive reopening (quit / relaunch).
    const again = new AudioIndex({ path });
    expect(again.jobs()).toEqual([job()]);
    again.close();
  });
});

describe('LocalStore: backfilled segments (2.7)', () => {
  it('stores the flag locally and never sends it to the server', () => {
    const store = new LocalStore({ path: ':memory:' });
    store.applyPull(
      {
        changes: [
          { op: 'upsert', table: 'workspace', row: { id: 'ws', name: 'Me', kind: 'personal' } },
        ],
        cursor: 'c1',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      null,
    );
    store.createMeeting({
      meetingId: 'm1',
      documentId: 'd1',
      workspaceId: 'ws',
      ownerId: 'u1',
      title: 'Standup',
      startedAt: '2026-11-14T10:00:00.000Z',
    });
    const seg = {
      id: 's1',
      meetingId: 'm1',
      source: 'mic' as const,
      speakerLabel: null,
      startMs: 0,
      endMs: 10,
      text: 'filled in',
    };
    expect(store.saveSegment({ ...seg, backfilled: true })).toBe('inserted');
    expect(store.saveSegment({ ...seg, backfilled: true })).toBe('unchanged');
    store.saveSegment({ ...seg, id: 's2', startMs: 20, endMs: 30, text: 'live' });
    expect(store.segments('m1')).toEqual([
      { ...seg, backfilled: true },
      { ...seg, id: 's2', startMs: 20, endMs: 30, text: 'live' },
    ]);
    const pushed = store
      .takePushBatch(100)
      .filter((e) => e.op === 'upsert' && e.table === 'transcript_segment');
    expect(pushed).toHaveLength(2);
    for (const e of pushed) {
      expect(e.op === 'upsert' && 'backfilled' in e.row).toBe(false);
    }
    // A pulled echo of the segment (server copy) keeps the local flag.
    store.applyPull(
      {
        changes: [
          {
            op: 'upsert',
            table: 'transcript_segment',
            row: { ...seg, speakerLabel: null },
          },
        ],
        cursor: 'c2',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      'c1',
    );
    expect(store.segments('m1')[0]).toMatchObject({ id: 's1', backfilled: true });
    store.close();
  });
});
