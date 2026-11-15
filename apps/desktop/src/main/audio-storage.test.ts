import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AudioRecording,
  audioArchivePath,
  InMemoryAudioRecordingStore,
} from '@oat/audio/node';
import { storageSummarySchema } from '@oat/core/bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveFilePath,
  clampTitle,
  AudioStorage,
  type AudioStorageOptions,
  audioRoot,
  meetingFolder,
  StorageError,
  SWEEP_INTERVAL_MS,
} from './audio-storage.ts';
import { DAY_MS } from './retention.ts';

const NOW = Date.UTC(2026, 10, 15, 12);
const MB = 1_000_000;

let dir: string;
let store: InMemoryAudioRecordingStore;
let active: string | null;
let revealed: string[];
let changed: number;
let logs: string[];
let user: string | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-storage-'));
  store = new InMemoryAudioRecordingStore();
  active = null;
  revealed = [];
  changed = 0;
  logs = [];
  user = 'u1';
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function storage(extra: Partial<AudioStorageOptions> = {}) {
  return new AudioStorage({
    baseDir: dir,
    store,
    settingsFile: join(dir, 'audio-retention.json'),
    currentUser: () => user,
    activeMeeting: () => active,
    // `known…` meetings are the signed-in account's notes; `shared…` ones it has but doesn't own.
    meetingInfo: (id) =>
      id.startsWith('known') || id.startsWith('shared')
        ? { title: `Note ${id}`, recorded: true, owned: id.startsWith('known') }
        : null,
    reveal: (path) => revealed.push(path),
    onChanged: () => changed++,
    log: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    now: () => NOW,
    ...extra,
  });
}

let ids = 0;
/** One part of a meeting (mic + system), `bytes` per file, last written `daysAgo`. */
async function record(
  meetingId: string,
  {
    daysAgo = 10,
    bytes = MB,
    part = 1,
    status = 'complete' as AudioRecording['status'],
    userId = 'u1' as string | null,
  } = {},
): Promise<string[]> {
  const startedAt = NOW - daysAgo * DAY_MS;
  const paths: string[] = [];
  for (const source of ['mic', 'system'] as const) {
    const path = audioArchivePath(dir, meetingId, source, part);
    mkdirSync(join(dir, 'audio', meetingId), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
    const t = new Date(startedAt + 60_000);
    utimesSync(path, t, t);
    await store.insert({
      id: `r${++ids}`,
      meetingId,
      source,
      part,
      offsetMs: 0,
      path,
      codec: 'opus',
      sampleRate: 16000,
      startedAt,
      durationMs: 60_000,
      bytes,
      status,
      userId,
    });
    paths.push(path);
  }
  return paths;
}

describe('path guard', () => {
  const root = '/data/audio';

  it('meeting folders stay directly inside the audio root', () => {
    expect(audioRoot('/data')).toBe(root);
    expect(meetingFolder(root, 'm1')).toBe('/data/audio/m1');
    for (const bad of ['..', '.', '', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(200), '/etc']) {
      expect(meetingFolder(root, bad), bad).toBeNull();
    }
  });

  it('only archive file names inside the meeting folder are accepted', () => {
    expect(archiveFilePath(root, 'm1', '/data/audio/m1/mic.opus')).toBe('/data/audio/m1/mic.opus');
    expect(archiveFilePath(root, 'm1', '/data/audio/m1/system.12.opus')).toBe(
      '/data/audio/m1/system.12.opus',
    );
    for (const bad of [
      '/data/audio/m1/../m2/mic.opus', // another meeting
      '/data/audio/m2/mic.opus',
      '/data/audio/m1/notes.sqlite', // not audio
      '/data/audio/m1/mic.opus.bak',
      '/data/audio/m1/mic.0.opus',
      '/data/audio/m1/sub/mic.opus',
      '/data/oat-u1.sqlite',
      '/etc/passwd',
      'mic.opus', // relative: resolves against the cwd
    ]) {
      expect(archiveFilePath(root, 'm1', bad), bad).toBeNull();
    }
    expect(archiveFilePath(root, '../m1', '/data/audio/m1/mic.opus')).toBeNull();
  });
});

describe('AudioStorage', () => {
  it('lists meetings with their size on disk, parts and titles, newest first', async () => {
    await record('known-a', { daysAgo: 10, bytes: 2 * MB });
    await record('known-a', { daysAgo: 9, bytes: MB, part: 2 });
    await record('other', { daysAgo: 3, bytes: 3 * MB, status: 'partial' });
    await record('gone', { daysAgo: 20 });
    await storage().deleteAudio('gone');

    const summary = await storage().summary();
    expect(summary.totalBytes).toBe(2 * (2 * MB + MB + 3 * MB));
    expect(summary.deletedMeetings).toBe(1);
    expect(summary.meetingCount).toBe(2);
    expect(summary.otherAccounts).toEqual({ meetings: 0, bytes: 0 });
    expect(summary.policy).toEqual({ kind: 'forever' });
    expect(summary.meetings).toEqual([
      expect.objectContaining({
        meetingId: 'other',
        title: null,
        bytes: 6 * MB,
        parts: 1,
        status: 'partial',
        deletable: true,
      }),
      expect.objectContaining({
        meetingId: 'known-a',
        title: 'Note known-a',
        bytes: 6 * MB,
        parts: 2,
        durationMs: 120_000,
        status: 'complete',
        startedAt: NOW - 10 * DAY_MS,
      }),
    ]);
  });

  it('the meeting being recorded is listed as recording and cannot be deleted', async () => {
    const paths = await record('known-live', { daysAgo: 0, status: 'recording' });
    active = 'known-live';
    const s = storage();
    expect((await s.summary()).meetings[0]).toMatchObject({
      status: 'recording',
      deletable: false,
    });
    const error = await s.deleteAudio('known-live').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ code: 'invalid_state' });
    for (const p of paths) expect(existsSync(p)).toBe(true);
    expect((await store.list()).every((r) => r.status === 'recording')).toBe(true);
    // A crash-left `recording` row of a meeting that isn't active is just partial audio.
    active = null;
    expect((await s.summary()).meetings[0]).toMatchObject({ status: 'partial', deletable: true });
  });

  it('delete removes the files, marks rows deleted and leaves everything else alone', async () => {
    const paths = await record('known-a', { bytes: 2 * MB });
    await record('known-a', { part: 2 });
    await record('known-b');
    // The account's database, the audio index and a file we don't know about in another meeting.
    writeFileSync(join(dir, 'oat-u1.sqlite'), 'transcripts and notes');
    writeFileSync(join(dir, 'audio-index.sqlite'), 'index');
    writeFileSync(join(dir, 'audio', 'known-b', 'restored.opus'), 'x');

    const s = storage();
    expect(await s.deleteAudio('known-a')).toEqual({
      deleted: true,
      freedBytes: 6 * MB,
      alreadyGone: false,
    });
    for (const p of paths) expect(existsSync(p)).toBe(false);
    expect(existsSync(join(dir, 'audio', 'known-a'))).toBe(false); // empty folder removed
    const rows = await store.list({ meetingId: 'known-a' });
    expect(rows.map((r) => [r.part, r.status, r.bytes])).toEqual([
      [1, 'deleted', 0],
      [1, 'deleted', 0],
      [2, 'deleted', 0],
      [2, 'deleted', 0],
    ]);
    expect(readFileSync(join(dir, 'oat-u1.sqlite'), 'utf8')).toBe('transcripts and notes');
    expect(readFileSync(join(dir, 'audio-index.sqlite'), 'utf8')).toBe('index');
    expect(readdirSync(join(dir, 'audio', 'known-b')).sort()).toEqual([
      'mic.opus',
      'restored.opus',
      'system.opus',
    ]);
    expect(changed).toBe(1);
    // Again (e.g. a sweep got there first): nothing left to delete, said so.
    expect(await s.deleteAudio('known-a')).toEqual({
      deleted: false,
      freedBytes: 0,
      alreadyGone: true,
    });
    await expect(s.deleteAudio('../known-b')).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('a meeting folder that keeps unknown files is not removed', async () => {
    await record('m1');
    writeFileSync(join(dir, 'audio', 'm1', 'keep.txt'), 'x');
    await storage().deleteAudio('m1');
    expect(readdirSync(join(dir, 'audio', 'm1'))).toEqual(['keep.txt']);
  });

  it('never deletes a file a row points outside its meeting folder (tampered index)', async () => {
    const outside = join(dir, 'oat-u1.sqlite');
    writeFileSync(outside, 'notes');
    const other = await record('m2');
    await record('m1');
    const template = (await store.list({ meetingId: 'm1' }))[0]!;
    for (const [id, path] of [
      ['evil1', outside],
      ['evil2', other[0]!],
      ['evil3', join(dir, 'audio', 'm1', '..', '..', 'oat-u1.sqlite')],
    ] as const) {
      await store.insert({ ...template, id, path, part: 3 });
    }
    const result = await storage().deleteAudio('m1');
    expect(result.deleted).toBe(false); // some rows were refused
    expect(readFileSync(outside, 'utf8')).toBe('notes');
    for (const p of other) expect(existsSync(p)).toBe(true);
    expect(logs.join('\n')).toMatch(/outside its meeting folder/);
    expect((await store.get('evil1'))!.status).toBe('complete');
  });

  it('refuses symlinks: a linked file or a linked meeting folder is never followed', async () => {
    const victimDir = mkdtempSync(join(tmpdir(), 'oat-victim-'));
    try {
      writeFileSync(join(victimDir, 'mic.opus'), 'precious');
      // m1/mic.opus → a file elsewhere.
      await record('m1');
      rmSync(join(dir, 'audio', 'm1', 'mic.opus'));
      symlinkSync(join(victimDir, 'mic.opus'), join(dir, 'audio', 'm1', 'mic.opus'));
      // m2 → a folder elsewhere.
      await store.insert({
        ...(await store.list({ meetingId: 'm1' }))[0]!,
        id: 'linked',
        meetingId: 'm2',
        path: join(dir, 'audio', 'm2', 'mic.opus'),
      });
      symlinkSync(victimDir, join(dir, 'audio', 'm2'));

      const s = storage();
      expect((await s.deleteAudio('m1')).deleted).toBe(false);
      expect(await s.deleteAudio('m2')).toMatchObject({ deleted: false, freedBytes: 0 });
      expect(readFileSync(join(victimDir, 'mic.opus'), 'utf8')).toBe('precious');
      expect(await s.show('m2')).toEqual({ shown: false });
      expect(revealed).toEqual([]);
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it('show reveals the validated meeting folder', async () => {
    await record('known-a');
    const s = storage();
    expect(await s.show('known-a')).toEqual({ shown: true });
    expect(revealed).toEqual([join(dir, 'audio', 'known-a')]);
    expect(await s.show('missing')).toEqual({ shown: false });
    await expect(s.show('..')).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(s.show('a/b')).rejects.toBeInstanceOf(StorageError);
    expect(revealed).toHaveLength(1);
  });

  it('audio status: available, recording, deleted, other device, none', async () => {
    await record('known-a');
    await record('known-b');
    await record('known-c', { status: 'failed' });
    const s = storage();
    await s.deleteAudio('known-b');
    expect(await s.audioStatus('known-a')).toMatchObject({
      status: 'available',
      bytes: 2 * MB,
      parts: 1,
    });
    expect((await s.audioStatus('known-b')).status).toBe('deleted');
    expect((await s.audioStatus('known-elsewhere')).status).toBe('other-device');
    expect((await s.audioStatus('unknown')).status).toBe('none');
    expect((await s.audioStatus('known-c')).status).toBe('none');
    active = 'known-a';
    expect((await s.audioStatus('known-a')).status).toBe('recording');
    // Files removed behind the app's back read as deleted.
    await record('known-d');
    rmSync(join(dir, 'audio', 'known-d'), { recursive: true });
    expect((await s.audioStatus('known-d')).status).toBe('deleted');
  });
});

describe('retention sweeper', () => {
  it('a size cap deletes the oldest meetings first and saves the policy', async () => {
    await record('m30', { daysAgo: 30, bytes: 200 * MB });
    await record('m10', { daysAgo: 10, bytes: 150 * MB });
    await record('m2', { daysAgo: 2, bytes: 100 * MB });
    const s = storage();
    // Total 900 MB, cap 0.6 GB → m30 (400 MB) goes → 500 MB.
    const preview = await s.preview({ kind: 'size', gb: 0.6 });
    expect(preview).toEqual({
      meetings: 1,
      bytes: 400 * MB,
      meetingIds: ['m30'],
      overCapAfter: false,
    });
    expect((await store.list()).every((r) => r.status === 'complete')).toBe(true); // dry run

    const summary = await s.setPolicy({ kind: 'size', gb: 0.6 });
    expect(summary.meetings.map((m) => m.meetingId)).toEqual(['m2', 'm10']);
    expect(summary.totalBytes).toBe(500 * MB);
    expect(summary.policy).toEqual({ kind: 'size', gb: 0.6 });
    expect(summary.lastSweep).toEqual({
      at: NOW,
      reason: 'policy',
      meetings: 1,
      freedBytes: 400 * MB,
      skipped: 0,
    });
    expect(existsSync(join(dir, 'audio', 'm30'))).toBe(false);
    // Persisted: a new instance (next launch) has it.
    expect(storage().policy).toEqual({ kind: 'size', gb: 0.6 });
    expect(JSON.parse(readFileSync(join(dir, 'audio-retention.json'), 'utf8'))).toMatchObject({
      version: 2,
      accounts: { u1: { policy: { kind: 'size', gb: 0.6 } } },
    });
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('age policy deletes old meetings only', async () => {
    await record('m30', { daysAgo: 30 });
    await record('m2', { daysAgo: 2 });
    const summary = await storage().setPolicy({ kind: 'age', days: 7 });
    expect(summary.meetings.map((m) => m.meetingId)).toEqual(['m2']);
  });

  it('never deletes the active recording or audio from the last hour', async () => {
    // 180 MB in all, cap 100 MB: only `old` may go, which leaves 120 MB.
    await record('old', { daysAgo: 30, bytes: 30 * MB });
    const live = await record('live', { daysAgo: 30, bytes: 30 * MB, status: 'recording' });
    const fresh = await record('fresh', { daysAgo: 30, bytes: 30 * MB });
    // `fresh` started long ago (a resumed meeting) but its file was written 10 minutes ago.
    for (const p of fresh) utimesSync(p, new Date(NOW - 600_000), new Date(NOW - 600_000));
    active = 'live';
    const s = storage();
    await s.setPolicy({ kind: 'size', gb: 0.1 });
    const result = await s.sweep('interval');
    expect(result).toMatchObject({ meetings: 0, freedBytes: 0 });
    for (const p of [...live, ...fresh]) expect(existsSync(p)).toBe(true);
    expect(existsSync(join(dir, 'audio', 'old'))).toBe(false);
    expect((await s.preview({ kind: 'size', gb: 0.1 })).overCapAfter).toBe(true);
  });

  it('a recording that starts between plan and delete is skipped', async () => {
    await record('m1', { daysAgo: 30 });
    await record('m2', { daysAgo: 20 });
    let calls = 0;
    const s = storage({
      // The plan sees nothing active; by the time m1 would be deleted, it is being recorded.
      activeMeeting: () => (++calls > 2 ? 'm1' : null),
    });
    await s.setPolicy({ kind: 'age', days: 7 });
    const rows = await store.list();
    expect(rows.filter((r) => r.meetingId === 'm1').every((r) => r.status === 'complete')).toBe(
      true,
    );
    expect(rows.filter((r) => r.meetingId === 'm2').every((r) => r.status === 'deleted')).toBe(
      true,
    );
    expect((await s.summary()).lastSweep).toMatchObject({ meetings: 1, skipped: 1 });
  });

  it('keep forever never deletes; an unreadable settings file means keep forever', async () => {
    await record('m30', { daysAgo: 300 });
    writeFileSync(
      join(dir, 'audio-retention.json'),
      '{"version":2,"accounts":{"u1":{"policy":{"kind":"size","gb":-1}}}}',
    );
    const s = storage();
    expect(s.policy).toEqual({ kind: 'forever' });
    expect(logs.join()).toMatch(/ignoring unreadable/);
    expect(await s.sweep('launch')).toMatchObject({ meetings: 0 });
    expect(existsSync(join(dir, 'audio', 'm30'))).toBe(true);
  });

  it('sweeps on launch, every 6 hours and after a recording', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    writeFileSync(
      join(dir, 'audio-retention.json'),
      JSON.stringify({ version: 2, accounts: { u1: { policy: { kind: 'age', days: 7 } } } }),
    );
    await record('m30', { daysAgo: 30 });
    const s = storage();
    const sweep = vi.spyOn(s, 'sweep');
    s.start();
    expect(sweep).toHaveBeenLastCalledWith('launch');
    await vi.waitFor(() => expect(existsSync(join(dir, 'audio', 'm30'))).toBe(false));

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenLastCalledWith('interval');
    s.recordingEnded();
    expect(sweep).toHaveBeenLastCalledWith('recording');
    expect(sweep).toHaveBeenCalledTimes(3);
    s.stop();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(3);
    await s.sweep('interval');
  });

  it('deletes and sweeps never overlap', async () => {
    await record('m1', { daysAgo: 30 });
    const s = storage();
    await s.setPolicy({ kind: 'forever' });
    const [a, b] = await Promise.all([s.deleteAudio('m1'), s.deleteAudio('m1')]);
    expect([a.deleted, b.deleted].sort()).toEqual([false, true]);
    expect([a.alreadyGone, b.alreadyGone].sort()).toEqual([false, true]);
    expect(a.freedBytes + b.freedBytes).toBe(2 * MB);
  });
});

describe('review fixes (3.8)', () => {
  it('a 1000-character title never breaks the list (clamped to the bridge limit)', async () => {
    await record('known-long');
    const long = 'Quarterly planning '.repeat(60).slice(0, 1000);
    const s = storage({
      meetingInfo: () => ({ title: long, recorded: true, owned: true }),
    });
    const summary = await s.summary();
    expect(storageSummarySchema.safeParse(summary).success).toBe(true);
    const title = summary.meetings[0]!.title!;
    expect(title).toHaveLength(200);
    expect(title.endsWith('…')).toBe(true);
    expect(clampTitle('short')).toBe('short');
    // A surrogate pair is never split.
    expect(clampTitle(`${'a'.repeat(198)}😀😀`).endsWith('a…')).toBe(true);
  });

  it('a concurrent sweep and policy save: the policy lands on disk and in memory, files are unique', async () => {
    await record('known-a', { daysAgo: 30 });
    const s = storage();
    await s.setPolicy({ kind: 'age', days: 60 });
    const runs = await Promise.all([
      s.sweep('interval'),
      s.setPolicy({ kind: 'size', gb: 5 }),
      s.sweep('launch'),
      s.setPolicy({ kind: 'age', days: 7 }),
      s.sweep('interval'),
    ]);
    expect(runs).toHaveLength(5);
    expect(s.policy).toEqual({ kind: 'age', days: 7 });
    const file = JSON.parse(readFileSync(join(dir, 'audio-retention.json'), 'utf8')) as {
      accounts: { u1: { policy: unknown; lastSweep: unknown } };
    };
    expect(file.accounts.u1.policy).toEqual({ kind: 'age', days: 7 });
    expect(file.accounts.u1.lastSweep).toMatchObject({ at: NOW });
    expect(storage().policy).toEqual({ kind: 'age', days: 7 }); // next launch
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(existsSync(join(dir, 'audio', 'known-a'))).toBe(false); // the 7-day policy applied
  });

  it('a policy that fails to save never becomes live', async () => {
    await record('known-a', { daysAgo: 30 });
    // The settings path is a folder: the rename fails.
    const settingsFile = join(dir, 'settings-dir');
    mkdirSync(join(settingsFile, 'inner'), { recursive: true });
    const s = storage({ settingsFile });
    await expect(s.setPolicy({ kind: 'age', days: 7 })).rejects.toThrow();
    expect(s.policy).toEqual({ kind: 'forever' });
    expect(await s.sweep('interval')).toMatchObject({ meetings: 0 });
    expect(existsSync(join(dir, 'audio', 'known-a', 'mic.opus'))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('stops deleting a meeting the moment it starts recording (re-checked per file)', async () => {
    const paths = await record('known-a');
    let calls = 0;
    // Not active when the delete is accepted, the meeting scanned and the first file deleted; active from
    // the second file on.
    const s = storage({ activeMeeting: () => (++calls > 3 ? 'known-a' : null) });
    const result = await s.deleteAudio('known-a');
    expect(result).toMatchObject({ deleted: false, alreadyGone: false });
    expect(paths.filter((p) => existsSync(p))).toHaveLength(1);
    expect(existsSync(join(dir, 'audio', 'known-a'))).toBe(true); // folder never removed
    expect(logs.join('\n')).toMatch(/started recording/);
  });
});

describe('accounts (D-30)', () => {
  async function setup() {
    await record('known-mine', { daysAgo: 30, bytes: 2 * MB });
    await record('theirs', { daysAgo: 40, bytes: 3 * MB, userId: 'u2' });
    // Rows from before D-30: one meeting this account owns, one it only has shared, one it doesn't know.
    await record('known-legacy', { daysAgo: 50, bytes: MB, userId: null });
    await record('shared-legacy', { daysAgo: 50, bytes: MB, userId: null });
    await record('unknown-legacy', { daysAgo: 50, bytes: MB, userId: null });
  }

  it('lists only the signed-in account; others are one aggregate; owned legacy rows are claimed', async () => {
    await setup();
    const summary = await storage().summary();
    expect(summary.meetings.map((m) => m.meetingId)).toEqual(['known-mine', 'known-legacy']);
    expect(summary.totalBytes).toBe(2 * (2 * MB + MB));
    expect(summary.otherAccounts).toEqual({ meetings: 3, bytes: 2 * (3 * MB + MB + MB) });
    const owners = Object.fromEntries(
      (await store.list()).map((r) => [r.meetingId, r.userId ?? null]),
    );
    expect(owners).toEqual({
      'known-mine': 'u1',
      theirs: 'u2',
      'known-legacy': 'u1', // claimed: this account owns the note
      'shared-legacy': null, // has the note, doesn't own it: stays unknown
      'unknown-legacy': null,
    });
  });

  it('never deletes, reveals or sweeps another account’s (or unknown) audio', async () => {
    await setup();
    const s = storage();
    expect(await s.deleteAudio('theirs')).toEqual({
      deleted: false,
      freedBytes: 0,
      alreadyGone: true,
    });
    expect(await s.deleteAudio('unknown-legacy')).toMatchObject({ alreadyGone: true });
    expect(await s.show('theirs')).toEqual({ shown: false });
    expect(revealed).toEqual([]);
    expect((await s.audioStatus('theirs')).status).toBe('none');
    // A cap that everything would exceed: only this account's meetings go.
    await s.setPolicy({ kind: 'size', gb: 0.1 });
    await s.setPolicy({ kind: 'age', days: 1 });
    for (const id of ['theirs', 'shared-legacy', 'unknown-legacy']) {
      expect(existsSync(join(dir, 'audio', id, 'mic.opus')), id).toBe(true);
    }
    for (const id of ['known-mine', 'known-legacy']) {
      expect(existsSync(join(dir, 'audio', id)), id).toBe(false);
    }
    expect((await s.summary()).otherAccounts.meetings).toBe(3);
  });

  it('the policy is per account; signed out nothing is listed, deleted or swept', async () => {
    await setup();
    const s = storage();
    await s.setPolicy({ kind: 'size', gb: 50 });
    user = 'u2';
    expect(s.policy).toEqual({ kind: 'forever' });
    expect((await s.summary()).meetings.map((m) => m.meetingId)).toEqual(['theirs']);
    await s.setPolicy({ kind: 'age', days: 90 });
    user = 'u1';
    expect(s.policy).toEqual({ kind: 'size', gb: 50 });

    user = null;
    const out = await s.summary();
    expect(out.meetings).toEqual([]);
    expect(out.policy).toEqual({ kind: 'forever' });
    expect(out.otherAccounts.meetings).toBe(5);
    await expect(s.deleteAudio('known-mine')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(s.setPolicy({ kind: 'age', days: 1 })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(await s.preview({ kind: 'age', days: 1 })).toMatchObject({ meetings: 0 });
    expect(await s.sweep('interval')).toMatchObject({ meetings: 0 });
    expect(existsSync(join(dir, 'audio', 'known-mine', 'mic.opus'))).toBe(true);
  });

  it('switching accounts sweeps with the new account’s policy', async () => {
    await setup();
    writeFileSync(
      join(dir, 'audio-retention.json'),
      JSON.stringify({ version: 2, accounts: { u2: { policy: { kind: 'age', days: 7 } } } }),
    );
    const s = storage();
    expect(await s.sweep('launch')).toMatchObject({ meetings: 0 }); // u1: keep forever
    user = 'u2';
    s.accountChanged();
    await vi.waitFor(() => expect(existsSync(join(dir, 'audio', 'theirs'))).toBe(false));
    expect(existsSync(join(dir, 'audio', 'known-mine', 'mic.opus'))).toBe(true);
    expect(changed).toBeGreaterThan(0);
  });
});
