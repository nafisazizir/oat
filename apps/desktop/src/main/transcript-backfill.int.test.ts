/**
 * Task 2.7 integration: STT down for 3 minutes in the middle of a recording, with the real pieces —
 * FileSource (fast: a 4½-minute replay of the standup fixture at 20× real time) → RecordingService →
 * RecordingArchive (Opus) + DeepgramProvider (live, default 120 s replay buffer) against the in-process
 * Deepgram mock, whose `/_mock/outage` switch takes it down and back. The 60 s that fell out of the replay
 * buffer are reported when the stream reconnects, queued, and back-filled through the mock's pre-recorded
 * API from the archive. Nothing is lost, nothing is duplicated. Loopback only (D-11), no Electron.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeWav, encodeWav, FileSource } from '@oat/audio/node';
import { AudioIndex, LocalStore } from '@oat/local-store';
import { startMocks, type RunningMocks } from '@oat/mocks';
import {
  DeepgramProvider,
  grantTokenSource,
  parseGroundTruth,
  resolveDeepgramEndpoints,
} from '@oat/stt';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import { RecordingService, type TranscriptGap } from './recording-service.ts';
import { TranscriptBackfill } from './transcript-backfill.ts';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/audio/', import.meta.url));
const REPEAT = 8;
const SPEED = 20;
const DOWN_AT_MS = 15_000;
const OUTAGE_MS = 180_000; // 3 minutes of audio

let mocks: RunningMocks;
let dir: string;
let wavPath: string;
let fixtureMs: number;
const truth = parseGroundTruth(
  JSON.parse(readFileSync(join(FIXTURES, 'standup-short.segments.json'), 'utf8')),
);

beforeAll(async () => {
  mocks = await startMocks();
  dir = mkdtempSync(join(tmpdir(), 'oat-backfill-int-'));
  // The fixture back to back, REPEAT times (FileSource has no loop option).
  const wav = decodeWav(readFileSync(join(FIXTURES, 'standup-short.wav')));
  fixtureMs = (wav.channels[0]!.length / wav.sampleRate) * 1000;
  const channels = wav.channels.map((ch) => {
    const out = new Int16Array(ch.length * REPEAT);
    for (let i = 0; i < REPEAT; i++) out.set(ch, i * ch.length);
    return out;
  });
  wavPath = join(dir, 'long.wav');
  writeFileSync(wavPath, encodeWav({ sampleRate: wav.sampleRate, channels }));
});
afterAll(async () => {
  await mocks.close();
  rmSync(dir, { recursive: true, force: true });
});

const outage = (down: boolean) =>
  fetch(`${mocks.url}/stt/_mock/outage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ down }),
  });

function provider() {
  const endpoints = resolveDeepgramEndpoints({ MOCKS_URL: mocks.url });
  return new DeepgramProvider({
    url: endpoints.listenUrl,
    getToken: grantTokenSource({ grantUrl: endpoints.grantUrl }),
    reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
    finishTimeoutMs: 8000,
  });
}

describe('STT down for 3 minutes (fast FileSource ↔ Deepgram mock)', () => {
  it('the lost stretch is reported on reconnect and back-filled from the archive', async () => {
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new LocalStore({ path: ':memory:' });
    store.applyPull(
      {
        changes: [
          {
            op: 'upsert',
            table: 'workspace',
            row: { id: 'ws', name: 'Me', kind: 'personal', role: 'owner' },
          },
        ],
        cursor: 'c',
        hasMore: false,
        workspaceIds: ['ws'],
      },
      null,
    );
    const index = new AudioIndex({ path: ':memory:' });
    const gaps: TranscriptGap[] = [];
    const backfill: TranscriptBackfill = new TranscriptBackfill({
      jobs: index,
      audio: index,
      liveAudio: () => service.liveAudio(),
      busyMeetingId: () => service.busyMeetingId,
      createProvider: async () => provider(),
      currentUser: () => 'u1',
      store: () => store,
      log,
      startDelayMs: 10,
    });
    const service: RecordingService = new RecordingService({
      baseDir: dir,
      log,
      store: index,
      userId: () => 'u1',
      persistence: new MeetingPersistence({
        store: () => store,
        userId: () => 'u1',
        workspaceTimeoutMs: 10,
        sync: { kick: () => {}, personalWorkspace: async () => 'ws' },
      }),
      createSource: () => new FileSource({ input: { stereo: wavPath }, speed: SPEED }),
      createStt: async () => provider(),
      onTranscriptGap: (gap) => {
        gaps.push(gap);
        backfill.enqueue({ ...gap, userId: 'u1' });
      },
    });

    const { meetingId } = await service.start({ spec: { input: 'file', fixture: 'long' } });
    // Drive the outage by audio time.
    let phase: 'before' | 'down' | 'up' = 'before';
    let outageActivatedAtMs: number | undefined;
    const control = setInterval(() => {
      const at = service.liveAudio()?.durationMs ?? 0;
      if (phase === 'before' && at >= DOWN_AT_MS) {
        phase = 'down';
        void outage(true).then(() => {
          outageActivatedAtMs = service.liveAudio()?.durationMs;
        });
      } else if (phase === 'down' && at >= DOWN_AT_MS + OUTAGE_MS) {
        phase = 'up';
        void outage(false);
      }
    }, 5);
    try {
      await vi.waitFor(() => expect(service.status).toBe('idle'), {
        timeout: 60_000,
        interval: 50,
      });
      await service.stop();
    } finally {
      clearInterval(control);
      await outage(false);
    }
    expect(phase).toBe('up');
    expect(outageActivatedAtMs).toBeDefined();

    // Reported on reconnect: what fell out of the 120 s replay buffer (≈ 15 s → 75 s), per source.
    const offline = gaps.filter((g) => g.reason === 'stt_offline');
    expect(offline.map((g) => g.source).sort()).toEqual(['mic', 'system']);
    for (const g of offline) {
      expect(g.startMs).toBeGreaterThan(outageActivatedAtMs! - 10_000);
      expect(g.startMs).toBeLessThanOrEqual(outageActivatedAtMs! + 1000);
      expect(g.endMs - g.startMs).toBeGreaterThan(OUTAGE_MS - 120_000 - 5000);
      // Reconnect lag in wall time × SPEED: ~375 ms on a loaded 4-vCPU runner was 7.5 s of audio.
      expect(g.endMs).toBeLessThan(DOWN_AT_MS + OUTAGE_MS - 120_000 + 15_000);
    }
    expect(service.snapshot().issues.some((i) => i.code === 'replay_overflow')).toBe(true);

    await vi.waitFor(
      () => expect(backfill.status(meetingId)).toMatchObject({ pendingMs: 0, running: false }),
      { timeout: 60_000, interval: 50 },
    );
    const status = backfill.status(meetingId);
    expect(status.failedMs).toBe(0);
    expect(status.segments).toBeGreaterThan(5);

    const segments = store.segments(meetingId);
    const filled = segments.filter((s) => s.backfilled);
    expect(filled.length).toBe(status.segments);
    for (const s of filled) {
      expect(
        offline.some(
          (g) =>
            g.source === s.source && s.startMs >= g.startMs - 1000 && s.endMs <= g.endMs + 1000,
        ),
      ).toBe(true);
    }
    // No duplicates: unique ids, no overlap within a source.
    expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
    for (const source of ['mic', 'system'] as const) {
      const list = segments.filter((s) => s.source === source);
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.startMs).toBeGreaterThanOrEqual(list[i - 1]!.endMs);
      }
    }
    // Nothing lost: every spoken line of every repetition overlaps a stored final of its source.
    const missing: string[] = [];
    for (let k = 0; k < REPEAT; k++) {
      for (const t of truth) {
        const start = t.startMs + k * fixtureMs;
        const end = t.endMs + k * fixtureMs;
        const hit = segments.some(
          (s) => s.source === t.source && s.startMs < end && start < s.endMs,
        );
        if (!hit)
          missing.push(`${t.source} ${Math.round(start / 1000)}–${Math.round(end / 1000)} s`);
      }
    }
    expect(missing).toEqual([]);
    // The back-fill went through the pre-recorded API, never past the gaps.
    const batches = mocks.log
      .list({ provider: 'stt' })
      .filter((r) => r.method === 'POST' && r.path === '/stt/v1/listen');
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches.every((r) => r.status === 200)).toBe(true);
    backfill.stop();
    store.close();
    index.close();
  }, 120_000);
});
