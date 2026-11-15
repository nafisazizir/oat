import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseSync } from 'node:sqlite';

import { AudioIndex } from './audio-index.ts';
import { AUDIO_MIGRATIONS } from './migrations.ts';
import { LocalStore } from './store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-audio-index-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = {
  id: 'a1',
  meetingId: 'm1',
  source: 'mic' as const,
  part: 1,
  offsetMs: 0,
  path: '/tmp/x/mic.opus',
  codec: 'opus' as const,
  sampleRate: 16000,
  startedAt: 1000,
  durationMs: 0,
  bytes: 0,
  status: 'recording' as const,
};

describe('AudioIndex', () => {
  it('implements the @oat/audio store', async () => {
    const index = new AudioIndex({ path: ':memory:' });
    await index.insert(row);
    await expect(index.insert(row)).rejects.toThrow();
    await index.insert({ ...row, id: 'a2', source: 'system' });
    const updated = await index.update('a1', { status: 'complete', durationMs: 5000, bytes: 9 });
    expect(updated).toMatchObject({ status: 'complete', durationMs: 5000, bytes: 9, part: 1 });
    expect(await index.get('a1')).toEqual(updated);
    expect((await index.list({ meetingId: 'm1' })).map((r) => r.id)).toEqual(['a1', 'a2']);
    expect((await index.list({ status: ['recording'] })).map((r) => r.id)).toEqual(['a2']);
    expect(await index.list({ status: [] })).toEqual([]);
    await expect(index.update('nope', {})).rejects.toThrow(/not found/);
    index.close();
  });

  it('survives a wipe of the cache: it is a separate file the cache never touches', async () => {
    const indexPath = join(dir, 'audio-index.sqlite');
    const cachePath = join(dir, 'oat-u1.sqlite');
    const index = new AudioIndex({ path: indexPath });
    await index.insert(row);
    index.close();
    // The cache gets corrupted and is rebuilt.
    new LocalStore({ path: cachePath }).close();
    writeFileSync(cachePath, Buffer.alloc(8192, 0x42));
    const cache = new LocalStore({ path: cachePath, log: { warn: () => {}, error: () => {} } });
    expect(cache.wiped).toBe('corrupt');
    cache.close();
    const again = new AudioIndex({ path: indexPath });
    expect(await again.get('a1')).toMatchObject({ meetingId: 'm1', part: 1 });
    again.close();
  });

  it('a corrupt index is moved aside, never deleted', () => {
    const indexPath = join(dir, 'audio-index.sqlite');
    writeFileSync(indexPath, Buffer.alloc(8192, 0x42));
    const errors: string[] = [];
    const index = new AudioIndex({
      path: indexPath,
      now: () => 42,
      log: { warn: () => {}, error: (m) => errors.push(m) },
    });
    expect(index.movedAside).toBe(`${indexPath}.corrupt-42`);
    expect(existsSync(`${indexPath}.corrupt-42`)).toBe(true);
    expect(readdirSync(dir)).toContain('audio-index.sqlite');
    expect(errors.join()).toMatch(/moved/);
    index.close();
  });

  it('D-30: rows carry the recording account; rows from before the migration are unknown', async () => {
    const indexPath = join(dir, 'audio-index.sqlite');
    // A version-1 index (before D-30) with one row.
    const old = new DatabaseSync(indexPath);
    old.exec(AUDIO_MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old
      .prepare(
        `INSERT INTO audio_recording (id, meeting_id, source, part, offset_ms, path, codec, sample_rate, started_at, duration_ms, bytes, status)
         VALUES ('old', 'm0', 'mic', 1, 0, '/x', 'opus', 16000, 1, 0, 0, 'complete')`,
      )
      .run();
    old.close();

    const index = new AudioIndex({ path: indexPath });
    expect(await index.get('old')).toMatchObject({ meetingId: 'm0', userId: null });
    await index.insert({ ...row, userId: 'u1' });
    await index.insert({ ...row, id: 'a2', userId: 'u2' });
    expect((await index.list({ userId: 'u1' })).map((r) => r.id)).toEqual(['a1']);
    expect((await index.list({ userId: null })).map((r) => r.id)).toEqual(['old']);
    // Claiming an unknown row; other fields untouched.
    expect(await index.update('old', { userId: 'u1' })).toMatchObject({ userId: 'u1', part: 1 });
    expect((await index.list({ userId: 'u1' })).map((r) => r.id).sort()).toEqual(['a1', 'old']);
    index.close();
  });
});
