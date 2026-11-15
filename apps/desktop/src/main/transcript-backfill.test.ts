/**
 * Task 2.7: gaps found by `RecordingService` → `TranscriptBackfill` → the archive (real Opus files from a
 * FileSource fixture replay) → batch STT (`FakeSttProvider.transcribe`, ground truth) → the local database.
 * And crash recovery: files repaired at launch, meeting closed, tail back-filled. No Electron, no network.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSource } from '@oat/audio/node';
import {
  FakeSttProvider,
  type FakeSttOptions,
  type GroundTruthSegment,
  parseGroundTruth,
  SttBatchError,
} from '@oat/stt';
import { AudioIndex, LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from './ipc.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import { recoverCrashedRecordings } from './recording-recovery.ts';
import { RecordingService, type TranscriptGap } from './recording-service.ts';
import { TranscriptBackfill } from './transcript-backfill.ts';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/audio/', import.meta.url));
const truth: GroundTruthSegment[] = parseGroundTruth(
  JSON.parse(readFileSync(join(FIXTURES, 'standup-short.segments.json'), 'utf8')),
);
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
const truthText = (source: 'mic' | 'system', upToMs = Infinity) =>
  words(
    truth
      .filter((t) => t.source === source && t.startMs < upToMs)
      .map((t) => t.text)
      .join(' '),
  );

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'oat-backfill-'));
});
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

const log = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function harness(
  fake: Partial<FakeSttOptions> = {},
  liveStt: 'fake' | 'none' = 'fake',
  extra: { sttDelayMs?: number; sttQueueFrames?: number; autoRun?: boolean } = {},
) {
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
  let user: string | null = 'u1';
  const persistence = new MeetingPersistence({
    store: () => store,
    userId: () => user,
    workspaceTimeoutMs: 10,
    sync: { kick: () => {}, personalWorkspace: async () => store.personalWorkspaceId() },
  });
  const gaps: (TranscriptGap & { recording: boolean })[] = [];
  const batch = new FakeSttProvider({ segments: truth, ...fake });
  const changes: string[] = [];
  const added: string[] = [];
  const backfill: TranscriptBackfill = new TranscriptBackfill({
    jobs: index,
    audio: index,
    liveAudio: () => service.liveAudio(),
    busyMeetingId: () => service.busyMeetingId,
    createProvider: async () => batch,
    currentUser: () => user,
    store: () => store,
    onSegments: (meetingId, segments) => {
      added.push(...segments.map((s) => s.id));
      service.addSegments(meetingId, segments);
    },
    onChange: (m) => changes.push(m),
    changeDebounceMs: 1,
    log: log(),
    // Only `runNow()` runs jobs unless a test wants the automatic kicks/retries (no race with assertions
    // about the state before the run when the machine is slow).
    startDelayMs: extra.autoRun ? 5 : 3_600_000,
    retryInitialMs: 20,
    retryMaxMs: 40,
    maxAttempts: 3,
    chunkMs: 10_000,
  });
  const service = new RecordingService({
    baseDir,
    log: log(),
    store: index,
    userId: () => user,
    persistence,
    stateThrottleMs: 5,
    batchMs: 5,
    createSource: () =>
      new FileSource({ input: { stereo: join(FIXTURES, 'standup-short.wav') }, speed: 'fast' }),
    ...(extra.sttQueueFrames ? { sttQueueFrames: extra.sttQueueFrames } : {}),
    createStt: async () => {
      if (extra.sttDelayMs) await new Promise((r) => setTimeout(r, extra.sttDelayMs));
      if (liveStt === 'none') throw new Error('no token');
      return new FakeSttProvider({ segments: truth, ...fake });
    },
    onTranscriptGap: (gap) => {
      gaps.push({ ...gap, recording: service.liveAudio() !== null });
      backfill.enqueue({ ...gap, userId: user });
    },
  });
  const record = async () => {
    const { meetingId } = await service.start({
      spec: { input: 'file', fixture: 'standup-short' },
    });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (service.status === 'idle' && !service.busy) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    await service.stop();
    return meetingId;
  };
  const stored = (meetingId: string, source: 'mic' | 'system') =>
    store.segments(meetingId).filter((s) => s.source === source);
  const textOf = (meetingId: string, source: 'mic' | 'system') =>
    words(
      stored(meetingId, source)
        .map((s) => s.text)
        .join(' '),
    );
  return {
    store,
    index,
    persistence,
    service,
    backfill,
    batch,
    gaps,
    changes,
    added,
    record,
    stored,
    textOf,
    setUser: (u: string | null) => (user = u),
  };
}

/** No two segments of a source overlap, ids are unique. */
function expectNoDuplicates(
  segments: { id: string; source: string; startMs: number; endMs: number }[],
) {
  expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
  for (const source of ['mic', 'system']) {
    const list = segments.filter((s) => s.source === source).sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.startMs, `${source} #${i}`).toBeGreaterThanOrEqual(list[i - 1]!.endMs);
    }
  }
}

describe('transcript back-fill (2.7)', () => {
  it('a stream that dies mid-meeting leaves gaps; they are filled from the archive, exactly once', async () => {
    const h = harness({ errorAtMs: 12_000, errorCode: 'auth' });
    const meetingId = await h.record();
    // Both streams died at 12 s: the rest of each source was reported at the end of the session.
    expect(h.gaps.map((g) => [g.source, g.reason])).toEqual(
      expect.arrayContaining([
        ['mic', 'stt_incomplete'],
        ['system', 'stt_incomplete'],
      ]),
    );
    for (const g of h.gaps) {
      expect(g.startMs).toBeLessThanOrEqual(12_100);
      expect(g.endMs).toBeGreaterThan(30_000);
    }
    const live = { mic: h.textOf(meetingId, 'mic'), system: h.textOf(meetingId, 'system') };
    expect(live.mic.length).toBeLessThan(truthText('mic').length);

    expect(h.backfill.status(meetingId)).toMatchObject({
      pendingMs: expect.any(Number),
      failedMs: 0,
    });
    expect(h.backfill.status(meetingId).pendingMs).toBeGreaterThan(30_000);
    await h.backfill.runNow();

    for (const source of ['mic', 'system'] as const) {
      expect(h.textOf(meetingId, source), source).toBe(truthText(source));
      const filled = h.stored(meetingId, source).filter((s) => s.backfilled);
      expect(filled.length).toBeGreaterThan(0);
      for (const s of filled) expect(s.startMs).toBeGreaterThanOrEqual(11_000);
    }
    expectNoDuplicates(h.store.segments(meetingId));
    const status = h.backfill.status(meetingId);
    expect(status).toMatchObject({ pendingMs: 0, failedMs: 0, running: false, error: null });
    expect(status.segments).toBe(h.store.segments(meetingId).filter((s) => s.backfilled).length);
    // Shown live too (the meeting is still the transcript's), and announced.
    expect(h.added.length).toBe(status.segments);
    expect(h.service.transcript().segments.filter((s) => s.backfilled)).toHaveLength(
      status.segments,
    );
    await vi.waitFor(() => expect(h.changes).toContain(meetingId));
    // Chunked (10 s) requests over the gaps only.
    expect(h.batch.batchRequests.every((r) => r.endMs - r.startMs <= 10_001)).toBe(true);
    expect(Math.min(...h.batch.batchRequests.map((r) => r.startMs))).toBeGreaterThan(5000);

    // Reporting the same gaps again queues nothing; re-running a done job's range adds nothing.
    for (const g of h.gaps) expect(h.backfill.enqueue({ ...g, userId: 'u1' })).toEqual([]);
    const before = h.store.segments(meetingId).length;
    h.index.updateJob(h.index.jobs()[0]!.id, {
      status: 'pending',
      doneMs: h.index.jobs()[0]!.startMs,
    });
    await h.backfill.runNow();
    expect(h.store.segments(meetingId)).toHaveLength(before);
  });

  it('no STT provider at all: the whole session of both sources is queued and filled', async () => {
    const h = harness({}, 'none');
    const meetingId = await h.record();
    expect(h.store.segments(meetingId)).toEqual([]);
    expect(h.gaps.map((g) => [g.source, g.reason, g.startMs])).toEqual([
      ['mic', 'stt_unavailable', 0],
      ['system', 'stt_unavailable', 0],
    ]);
    await h.backfill.runNow();
    expect(h.textOf(meetingId, 'mic')).toBe(truthText('mic'));
    expect(h.textOf(meetingId, 'system')).toBe(truthText('system'));
    expect(h.store.segments(meetingId).every((s) => s.backfilled)).toBe(true);
  });

  it('batch STT down: retries with backoff, says so, then fills in once it is back', async () => {
    let down = true;
    const h = harness({ errorAtMs: 20_000, batchFails: () => down }, 'fake', { autoRun: true });
    const meetingId = await h.record();
    await h.backfill.runNow();
    let status = h.backfill.status(meetingId);
    expect(status).toMatchObject({
      retrying: true,
      error: 'Transcription is unavailable right now.',
    });
    expect(status.pendingMs).toBeGreaterThan(0);
    down = false;
    await vi.waitFor(() => expect(h.backfill.status(meetingId).pendingMs).toBe(0), {
      timeout: 5000,
      interval: 20,
    });
    status = h.backfill.status(meetingId);
    expect(status).toMatchObject({ retrying: false, error: null, failedMs: 0 });
    expect(h.textOf(meetingId, 'mic')).toBe(truthText('mic'));
  });

  it('gives up after maxAttempts (visible as failed); a refusal waits the longest', async () => {
    const h = harness(
      { errorAtMs: 20_000, batchFails: () => new SttBatchError('auth', 'HTTP 401', false, 401) },
      'fake',
      { autoRun: true },
    );
    const meetingId = await h.record();
    for (let i = 0; i < 3; i++) await h.backfill.runNow().then(() => h.backfill.kick(0, true));
    await h.backfill.idle();
    const status = h.backfill.status(meetingId);
    expect(status.failedMs).toBeGreaterThan(0);
    expect(status.pendingMs).toBe(0);
    expect(status.error).toBe('Transcription refused the request.');
  });

  it('runs only for the recording account, with its database open', async () => {
    const h = harness({ errorAtMs: 20_000 });
    const meetingId = await h.record();
    h.setUser('someone-else');
    await h.backfill.runNow();
    expect(h.batch.batchRequests).toEqual([]);
    h.setUser(null);
    await h.backfill.runNow();
    expect(h.batch.batchRequests).toEqual([]);
    h.setUser('u1');
    await h.backfill.runNow();
    expect(h.textOf(meetingId, 'system')).toBe(truthText('system'));
  });

  it('audio deleted before the job ran: the job fails and says why', async () => {
    const h = harness({ errorAtMs: 20_000 });
    const meetingId = await h.record();
    for (const row of await h.index.list({ meetingId })) {
      await h.index.update(row.id, { status: 'deleted', bytes: 0 });
    }
    await h.backfill.runNow();
    expect(h.backfill.status(meetingId)).toMatchObject({
      pendingMs: 0,
      error: 'The audio of this part is no longer on this Mac.',
    });
    expect(h.backfill.status(meetingId).failedMs).toBeGreaterThan(0);
  });

  it('enqueue cuts new reports against queued ranges of that meeting and source', () => {
    const h = harness();
    const gap = {
      meetingId: 'm',
      userId: 'u1',
      source: 'mic' as const,
      reason: 'stt_offline' as const,
    };
    expect(h.backfill.enqueue({ ...gap, startMs: 10_000, endMs: 20_000 })).toHaveLength(1);
    const more = h.backfill.enqueue({ ...gap, startMs: 5000, endMs: 30_000 });
    expect(more.map((j) => [j.startMs, j.endMs])).toEqual([
      [5000, 10_000],
      [20_000, 30_000],
    ]);
    expect(
      h.backfill.enqueue({ ...gap, source: 'system', startMs: 10_000, endMs: 20_000 }),
    ).toHaveLength(1);
    expect(h.backfill.enqueue({ ...gap, startMs: 30_000, endMs: 30_300 })).toEqual([]); // too short
    h.backfill.stop();
  });
});

describe('crash recovery (2.7)', () => {
  it('repairs the files, closes the meeting at its end, back-fills the tail; no duplicates', async () => {
    const h = harness();
    const meetingId = await h.record();
    const rows = await h.index.list({ meetingId });
    // What a crash leaves: rows still "recording", files cut mid-page (here at ~70 % of their bytes), the
    // meeting open and only the finals saved before it (a few seconds behind the audio).
    for (const row of rows) {
      truncateSync(row.path, Math.round(statSync(row.path).size * 0.7) + 37);
      await h.index.update(row.id, { status: 'recording', durationMs: 0, bytes: 0 });
    }
    h.store.updateMeeting(meetingId, { endedAt: null });

    // Launch: repair before anything else.
    const recoveries = await recoverCrashedRecordings({
      audio: h.index,
      jobs: h.index,
      log: log(),
      now: () => 99,
    });
    expect(recoveries).toHaveLength(1);
    const repaired = await h.index.list({ meetingId });
    expect(repaired.map((r) => r.status)).toEqual(['partial', 'partial']);
    for (const r of repaired) {
      expect(r.durationMs).toBeGreaterThan(5000);
      expect(r.durationMs).toBeLessThan(rows[0]!.durationMs);
    }
    const cutAtMs = Math.min(...repaired.map((r) => r.durationMs));
    for (const s of h.store.segments(meetingId)) {
      if (s.endMs > cutAtMs - 4000) h.store.deleteSegment(s.id);
    }
    const kept = h.store.segments(meetingId).map((s) => s.id);
    expect(kept.length).toBeGreaterThan(1);
    const savedUntil = Math.max(...repaired.map((r) => r.startedAt + r.durationMs));
    expect(recoveries[0]).toMatchObject({
      meetingId,
      userId: 'u1',
      savedUntil: Math.round(savedUntil),
    });
    // A second launch finds nothing to repair.
    expect(await recoverCrashedRecordings({ audio: h.index, jobs: h.index, log: log() })).toEqual(
      [],
    );

    // Account ready: meeting closed at the saved end, tails queued and filled.
    await h.backfill.runNow();
    const meeting = h.store.meeting(meetingId)!;
    expect(meeting.endedAt).not.toBeNull();
    expect(Date.parse(meeting.endedAt!)).toBeGreaterThanOrEqual(Math.round(savedUntil) - 1);
    expect(
      h.index.jobs({ meetingId }).every((j) => j.reason === 'crash' && j.status === 'done'),
    ).toBe(true);
    const segments = h.store.segments(meetingId);
    expect(segments.map((s) => s.id)).toEqual(expect.arrayContaining(kept));
    expectNoDuplicates(segments);
    // Up to where the audio was saved, the transcript is the ground truth again.
    const end = Math.min(...repaired.map((r) => r.durationMs));
    for (const source of ['mic', 'system'] as const) {
      const fullyBefore = truth
        .filter((t) => t.source === source && t.endMs < end)
        .map((t) => words(t.text))
        .join(' ');
      expect(h.textOf(meetingId, source).startsWith(fullyBefore), source).toBe(true);
    }
    expect(h.backfill.status(meetingId)).toMatchObject({
      recoveredAt: 99,
      savedUntil: Math.round(savedUntil),
    });
    expect(h.index.recoveries({ applied: false })).toEqual([]);
  });
});

/** What a crash leaves of a recorded meeting: rows still `recording`, files cut, the meeting open. */
async function crash(h: ReturnType<typeof harness>, meetingId: string) {
  for (const row of await h.index.list({ meetingId })) {
    truncateSync(row.path, Math.round(statSync(row.path).size * 0.7) + 37);
    await h.index.update(row.id, { status: 'recording', durationMs: 0, bytes: 0 });
  }
  h.store.updateMeeting(meetingId, { endedAt: null });
}

describe('review 2.7', () => {
  it('#1 any start path waits for crash recovery: a resumed part starts after the repaired audio', async () => {
    const h = harness();
    const meetingId = await h.record();
    await crash(h, meetingId);
    // The stored transcript lags the audio (STT was behind when it crashed).
    for (const s of h.store.segments(meetingId)) if (s.endMs > 6000) h.store.deleteSegment(s.id);
    // Relaunch: recovery runs in the background; a detection-initiated start comes in immediately.
    const recovered = recoverCrashedRecordings({ audio: h.index, jobs: h.index, log: log() });
    const relaunched = new RecordingService({
      baseDir,
      log: log(),
      store: h.index,
      userId: () => 'u1',
      persistence: h.persistence,
      ready: recovered,
      createSource: () =>
        new FileSource({
          input: { stereo: join(FIXTURES, 'standup-short.wav') },
          speed: 'fast',
          durationMs: 2000,
        }),
      createStt: async () => new FakeSttProvider({ segments: truth }),
    });
    await relaunched.start({ meetingId, spec: { input: 'file', fixture: 'standup-short' } });
    await relaunched.stop();
    const rows = await h.index.list({ meetingId });
    const part1 = rows.filter((r) => r.part === 1);
    const part1End = Math.max(...part1.map((r) => r.offsetMs + r.durationMs));
    expect(part1.map((r) => r.status)).toEqual(['partial', 'partial']);
    const part2 = rows.filter((r) => r.part === 2);
    expect(part2).toHaveLength(2);
    // Never overlapping the crashed part on the meeting clock.
    for (const r of part2) expect(r.offsetMs).toBeGreaterThanOrEqual(Math.round(part1End) - 1);
    expect(part1End).toBeGreaterThan(5000);
  });

  it('#2 an account switch mid-chunk writes nothing anywhere and counts no attempt', async () => {
    const h = harness({ errorAtMs: 12_000 });
    const meetingId = await h.record();
    h.backfill.stop();
    // Account B's database knows the meeting too (a note shared with B).
    const storeB = new LocalStore({ path: ':memory:' });
    storeB.applyPull(
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
    const m = h.store.meeting(meetingId)!;
    storeB.createMeeting({
      meetingId,
      documentId: m.documentId,
      workspaceId: 'ws',
      ownerId: 'u1',
      title: 'Shared',
      startedAt: m.startedAt!,
    });
    let user = 'u1';
    let switchDuringTranscribe = true;
    const users: string[] = [];
    const fake = new FakeSttProvider({ segments: truth });
    const provider = {
      name: 'switching',
      openStream: fake.openStream.bind(fake),
      transcribe: async (req: Parameters<FakeSttProvider['transcribe']>[0]) => {
        const result = await fake.transcribe(req);
        // Signed out and in as B while A's chunk was being transcribed.
        if (switchDuringTranscribe) user = 'u2';
        return result;
      },
    };
    const backfill = new TranscriptBackfill({
      jobs: h.index,
      audio: h.index,
      liveAudio: () => null,
      createProvider: async (u) => (users.push(u), provider),
      currentUser: () => user,
      store: () => (user === 'u1' ? h.store : storeB),
      log: log(),
      startDelayMs: 5,
      chunkMs: 10_000,
    });
    const before = h.index.jobs({ meetingId });
    expect(before.length).toBeGreaterThan(0);
    const segmentsBefore = h.store.segments(meetingId).length;
    await backfill.runNow();
    expect(users).toEqual(['u1']);
    expect(storeB.segments(meetingId)).toEqual([]);
    expect(storeB.outbox().filter((e) => e.table === 'transcript_segment')).toEqual([]);
    expect(h.store.segments(meetingId)).toHaveLength(segmentsBefore);
    // Untouched: same cursor, no attempt, still pending.
    expect(h.index.jobs({ meetingId })).toEqual(before);
    // B sees nothing of A's jobs (D-30).
    expect(backfill.status(meetingId)).toMatchObject({ pendingMs: 0, segments: 0 });
    // Back as A: it carries on and completes.
    user = 'u1';
    switchDuringTranscribe = false;
    await backfill.runNow();
    expect(h.index.jobs({ meetingId }).every((j) => j.status === 'done')).toBe(true);
    expect(h.textOf(meetingId, 'mic')).toBe(truthText('mic'));
    backfill.stop();
  });

  it('a recovery without an account (pre-D-30 rows) is claimed by the account owning the note', async () => {
    const h = harness();
    const meetingId = await h.record();
    await crash(h, meetingId);
    for (const row of await h.index.list({ meetingId })) {
      await h.index.update(row.id, { userId: null });
    }
    const [recovery] = await recoverCrashedRecordings({
      audio: h.index,
      jobs: h.index,
      log: log(),
    });
    expect(recovery!.userId).toBeNull();
    h.setUser('u2'); // not the owner: leaves it alone
    h.backfill.applyRecoveries();
    expect(h.index.recoveries({ applied: false })).toHaveLength(1);
    h.setUser('u1');
    h.backfill.applyRecoveries();
    expect(h.index.recoveries({ applied: true })[0]).toMatchObject({ userId: 'u1' });
    expect(h.store.meeting(meetingId)!.endedAt).not.toBeNull();
    expect(h.backfill.status(meetingId).savedUntil).toBe(recovery!.savedUntil);
    expect(h.index.jobs({ meetingId }).every((j) => j.userId === 'u1')).toBe(true);
    h.setUser(null);
    expect(h.backfill.status(meetingId)).toMatchObject({ savedUntil: null, pendingMs: 0 });
    h.backfill.stop();
  });

  it('frames dropped from the STT queue are queued while still recording (a crash keeps them)', async () => {
    const h = harness({}, 'fake', { sttDelayMs: 300, sttQueueFrames: 20 });
    const meetingId = await h.record();
    const dropped = h.gaps.filter((g) => g.reason === 'stt_dropped');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.some((g) => g.recording)).toBe(true);
    await h.backfill.runNow();
    expect(h.textOf(meetingId, 'mic')).toBe(truthText('mic'));
    expectNoDuplicates(h.store.segments(meetingId));
  });
});
