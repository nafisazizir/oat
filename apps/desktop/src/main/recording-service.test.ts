/**
 * RecordingService with the real pipeline pieces: FileSource (fixture WAV) → RecordingController →
 * RecordingArchive (Opus files in a temp dir) + FakeSttProvider (ground truth). No Electron, no network.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AudioRecordingStore,
  type AudioSource,
  FileSource,
  type FileSourceSpeed,
} from '@oat/audio';
import type {
  RecordingSnapshot,
  RecordingStatus,
  TranscriptBatch,
  LiveSegment,
} from '@oat/core/bridge';
import {
  FakeSttProvider,
  type FakeSttOptions,
  type GroundTruthSegment,
  parseGroundTruth,
  type SttProvider,
} from '@oat/stt';
import { AudioIndex, LocalStore } from '@oat/local-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptStore } from '../shared/transcript.ts';
import type { Logger } from './ipc.ts';
import { MeetingPersistence } from './meeting-persistence.ts';
import {
  type InputSpec,
  type PowerEvents,
  RecordingService,
  RecordingServiceError,
  type TranscriptPersistence,
} from './recording-service.ts';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/audio/', import.meta.url));
const truth: GroundTruthSegment[] = parseGroundTruth(
  JSON.parse(readFileSync(join(FIXTURES, 'standup-short.segments.json'), 'utf8')),
);

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'oat-recording-'));
});
afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

interface Harness {
  service: RecordingService;
  states: RecordingSnapshot[];
  batches: TranscriptBatch[];
  statuses: RecordingStatus[];
  /** What a window would show (applies every batch). */
  view: TranscriptStore;
  log: Logger;
  waitFor: (status: RecordingStatus) => Promise<void>;
}

function setup({
  speed = 'fast' as FileSourceSpeed,
  startMs,
  durationMs,
  stt = (): Promise<SttProvider> => Promise.resolve(new FakeSttProvider({ segments: truth })),
  source,
  power,
  persistence,
  store,
}: {
  speed?: FileSourceSpeed;
  startMs?: number;
  durationMs?: number;
  stt?: () => Promise<SttProvider>;
  source?: (spec: InputSpec) => AudioSource;
  power?: PowerEvents;
  persistence?: TranscriptPersistence;
  store?: AudioRecordingStore;
} = {}): Harness {
  const states: RecordingSnapshot[] = [];
  const batches: TranscriptBatch[] = [];
  const statuses: RecordingStatus[] = [];
  const view = new TranscriptStore();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const waiters: { status: RecordingStatus; resolve: () => void }[] = [];
  const service = new RecordingService({
    baseDir,
    log,
    stateThrottleMs: 5,
    batchMs: 5,
    createSource:
      source ??
      ((spec) =>
        new FileSource({
          input: { stereo: join(FIXTURES, `${spec.input === 'file' ? spec.fixture : 'x'}.wav`) },
          speed,
          ...(startMs !== undefined ? { startMs } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })),
    createStt: stt,
    ...(power ? { power } : {}),
    ...(persistence ? { persistence } : {}),
    ...(store ? { store } : {}),
    onState: (s) => states.push(s),
    onSegments: (b) => {
      batches.push(b);
      view.apply(b.segments);
    },
    onStatus: (status) => {
      statuses.push(status);
      for (const w of waiters.filter((x) => x.status === status)) w.resolve();
    },
  });
  const waitFor = (status: RecordingStatus) =>
    service.status === status
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ status, resolve }));
  return { service, states, batches, statuses, view, log, waitFor };
}

const fixture: InputSpec = { input: 'file', fixture: 'standup-short' };
const finalsBySource = (segments: readonly LiveSegment[], source: 'mic' | 'system') =>
  normalize(
    segments
      .filter((s) => s.source === source && s.isFinal)
      .map((s) => s.text)
      .join(' '),
  );
const truthBySource = (source: 'mic' | 'system') =>
  normalize(
    truth
      .filter((t) => t.source === source)
      .map((t) => t.text)
      .join(' '),
  );

describe('RecordingService', () => {
  it('fixture → live two-source transcript (interim → final), archive files, clean stop', async () => {
    const h = setup();
    const { meetingId } = await h.service.start({ spec: fixture });
    expect(meetingId).toMatch(/^[0-9a-f-]{36}$/);
    await h.waitFor('idle'); // the fixture ended by itself
    const result = await h.service.stop();

    // Transcript: what windows built from the batches equals the main-process snapshot.
    const snap = h.service.transcript();
    expect(snap.meetingId).toBe(meetingId);
    expect(snap.seq).toBe(h.batches.length);
    expect(h.batches.map((b) => b.seq)).toEqual(h.batches.map((_, i) => i + 1));
    expect(h.view.segments).toEqual(snap.segments);
    // Interims were shown first and replaced (same id) by finals.
    const all = h.batches.flatMap((b) => b.segments);
    const interim = all.find((s) => !s.isFinal)!;
    expect(all.find((s) => s.id === interim.id && s.isFinal)).toBeDefined();
    expect(snap.segments.every((s) => s.isFinal)).toBe(true);
    for (const source of ['mic', 'system'] as const) {
      expect(finalsBySource(snap.segments, source)).toBe(truthBySource(source));
    }
    // Meeting clock = fixture time (first session, origin 0).
    expect(snap.segments[0]).toMatchObject({ source: 'mic', startMs: 500 });

    // Archive: one complete Opus file per source, as long as the fixture.
    expect(result.meetingId).toBe(meetingId);
    expect(result.audio.map((a) => [a.source, a.part, a.status])).toEqual([
      ['mic', 1, 'complete'],
      ['system', 1, 'complete'],
    ]);
    for (const a of result.audio) expect(a.durationMs).toBeGreaterThan(30_000);
    for (const source of ['mic', 'system']) {
      const file = join(baseDir, 'audio', meetingId, `${source}.opus`);
      expect(statSync(file).size).toBeGreaterThan(1000);
    }

    // State pushes: recording, levels for both sources, STT open then closed, no issues.
    expect(h.statuses).toEqual(expect.arrayContaining(['starting', 'recording', 'idle']));
    const live = h.states.find((s) => s.status === 'recording' && s.levels.mic && s.levels.system);
    expect(live).toBeDefined();
    expect(h.states.some((s) => s.stt.mic === 'open' && s.stt.system === 'open')).toBe(true);
    const last = h.service.snapshot();
    expect(last).toMatchObject({ status: 'idle', issues: [], input: 'file' });
    expect(last.fixture).toBe('standup-short');
    expect(last.startedAt).not.toBeNull();
    expect(h.states.map((s) => s.seq)).toEqual(h.states.map((_, i) => i + 1));
  });

  it('STT down: the error is visible, recording and archive carry on', async () => {
    const h = setup({
      stt: async () => new FakeSttProvider({ segments: truth, failOpen: 'connection' }),
      durationMs: 6_000,
    });
    const { meetingId } = await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    const result = await h.service.stop();
    const snap = h.service.snapshot();
    expect(snap.stt).toEqual({ mic: 'error', system: 'error' });
    expect(snap.issues).toEqual([
      expect.objectContaining({ scope: 'stt', source: 'mic', fatal: true }),
      expect.objectContaining({ scope: 'stt', source: 'system', fatal: true }),
    ]);
    expect(snap.issues[0]!.message).toMatch(/Recording continues/);
    // The recording itself went the whole way and the audio is saved.
    expect(h.statuses).not.toContain('error');
    expect(result.audio.map((a) => a.status)).toEqual(['complete', 'complete']);
    for (const a of result.audio) expect(a.durationMs).toBeGreaterThan(5_500);
    expect(existsSync(join(baseDir, 'audio', meetingId, 'mic.opus'))).toBe(true);
    expect(h.service.transcript().segments).toEqual([]);
  });

  it('STT drops mid-meeting: reconnects, nothing lost or duplicated', async () => {
    const h = setup({
      stt: async () =>
        new FakeSttProvider({ segments: truth, disconnectAtMs: 9_000, reconnectDelayMs: 50 }),
    });
    await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    await h.service.stop();
    const snap = h.service.transcript();
    for (const source of ['mic', 'system'] as const) {
      expect(finalsBySource(snap.segments, source)).toBe(truthBySource(source));
    }
    expect(h.states.some((s) => s.stt.system === 'reconnecting')).toBe(true);
    expect(h.service.snapshot().issues[0]).toMatchObject({
      scope: 'stt',
      code: 'connection',
      fatal: false,
      message: expect.stringMatching(/Reconnecting; recording continues/),
    });
  });

  it('no STT provider at all (token/API down): reported, audio still archived', async () => {
    const h = setup({
      stt: () => Promise.reject(new Error('Transcription is unavailable.')),
      durationMs: 3_000,
    });
    await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    const result = await h.service.stop();
    expect(h.service.snapshot().issues).toEqual([
      expect.objectContaining({ scope: 'stt', code: 'unavailable', source: null, fatal: true }),
    ]);
    expect(result.audio.map((a) => a.status)).toEqual(['complete', 'complete']);
  });

  it('pause / resume: no audio while paused, elapsed stops, recording continues after', async () => {
    const h = setup({ speed: 4, durationMs: 8_000 });
    await h.service.start({ spec: fixture });
    await h.waitFor('recording');
    await new Promise((r) => setTimeout(r, 300));
    h.service.pause();
    expect(h.service.status).toBe('paused');
    const pausedAt = h.service.snapshot().elapsedMs;
    await new Promise((r) => setTimeout(r, 300));
    expect(h.service.snapshot().elapsedMs).toBe(pausedAt);
    expect(() => h.service.pause()).toThrow(RecordingServiceError);
    h.service.resume();
    expect(h.service.status).toBe('recording');
    await h.waitFor('idle');
    const result = await h.service.stop();
    expect(h.statuses).toEqual(expect.arrayContaining(['recording', 'paused', 'idle']));
    // FileSource doesn't skip audio across a pause: the files hold all 8 s.
    for (const a of result.audio) expect(a.durationMs).toBeGreaterThan(7_500);
  });

  it('stop while recording: resolves after the last finals and closed files', async () => {
    const h = setup({ speed: 'realtime' });
    const { meetingId } = await h.service.start({ spec: fixture });
    await h.waitFor('recording');
    await new Promise((r) => setTimeout(r, 1_500));
    const result = await h.service.stop();
    expect(h.service.status).toBe('idle');
    expect(h.statuses).toContain('stopping');
    expect(result.audio).toHaveLength(2);
    for (const a of result.audio) {
      expect(a.status).toBe('complete');
      expect(a.durationMs).toBeGreaterThan(1_000);
      expect(a.durationMs).toBeLessThan(5_000);
    }
    // finish() closed every interim: nothing provisional is left.
    expect(h.service.transcript().segments.every((s) => s.isFinal)).toBe(true);
    expect(h.service.transcript().meetingId).toBe(meetingId);
  });

  it('a second session of the same meeting is part 2, on the meeting clock after part 1', async () => {
    const h = setup({ durationMs: 6_000 });
    const { meetingId } = await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    await h.service.stop();
    const firstCount = h.service.transcript().segments.length;
    expect(firstCount).toBeGreaterThan(0);

    await h.service.start({ meetingId, spec: fixture });
    await h.waitFor('recording');
    await h.waitFor('idle');
    const second = await h.service.stop();
    expect(second.audio.map((a) => [a.source, a.part])).toEqual([
      ['mic', 2],
      ['system', 2],
    ]);
    expect(existsSync(join(baseDir, 'audio', meetingId, 'mic.2.opus'))).toBe(true);
    const rows = await h.service.audioStore.list({ meetingId });
    expect(rows.filter((r) => r.part === 2).every((r) => r.offsetMs >= 6_000)).toBe(true);
    // The transcript continues: part 1's segments stay, part 2's start after them.
    const segments = h.service.transcript().segments;
    expect(segments.length).toBe(firstCount * 2);
    expect(segments.slice(firstCount).every((s) => s.startMs >= 6_000)).toBe(true);
  });

  it('a new meeting starts a fresh transcript (seq restarts)', async () => {
    const h = setup({ durationMs: 3_000 });
    const first = await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    await h.service.stop();
    const second = await h.service.start({ spec: fixture });
    expect(second.meetingId).not.toBe(first.meetingId);
    expect(h.service.transcript()).toEqual({ meetingId: second.meetingId, seq: 0, segments: [] });
    await h.waitFor('idle');
    await h.service.stop();
  });

  it('refuses a second start while recording', async () => {
    const h = setup({ speed: 'realtime' });
    await h.service.start({ spec: fixture });
    await expect(h.service.start({ spec: fixture })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await h.service.stop();
  });

  it('a source that cannot start: visible error, stop acknowledges it', async () => {
    const h = setup({
      source: () => new FileSource({ input: { stereo: join(baseDir, 'missing.wav') } }),
    });
    await expect(h.service.start({ spec: fixture })).rejects.toBeInstanceOf(RecordingServiceError);
    expect(h.service.status).toBe('error');
    expect(h.service.snapshot().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'audio', code: 'start_failed', fatal: true }),
      ]),
    );
    await h.service.stop();
    expect(h.service.status).toBe('idle');
    // …and a new start works.
    expect(h.statuses.at(-1)).toBe('idle');
  });

  it('a createSource that throws (no sidecar binary) fails the start the same way', async () => {
    const h = setup({
      source: () => {
        throw new Error('oat-audio binary not found');
      },
    });
    await expect(h.service.start({ spec: { input: 'sidecar' } })).rejects.toMatchObject({
      message: 'Recording couldn’t start: the audio helper is missing.',
    });
    expect(h.service.status).toBe('error');
  });

  it('repeated identical STT errors collapse into one issue', async () => {
    const opts: FakeSttOptions = { segments: truth, failOpen: 'auth' };
    const h = setup({
      stt: async () => new FakeSttProvider(opts),
      durationMs: 2_000,
      source: () =>
        new FileSource({
          input: { mic: join(FIXTURES, 'standup-short.wav') },
          speed: 'fast',
          durationMs: 2_000,
        }),
    });
    await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    await h.service.stop();
    expect(h.service.snapshot().issues).toHaveLength(1);
    expect(h.service.snapshot().stt).toEqual({ mic: 'error', system: 'idle' });
  });
});

describe('RecordingService: quit and concurrency (review 2.5 #1)', () => {
  it('shutdown() during a Stop resolves only after the archive files are complete', async () => {
    const h = setup({ speed: 'realtime' });
    const { meetingId } = await h.service.start({ spec: fixture });
    await h.waitFor('recording');
    await new Promise((r) => setTimeout(r, 500));
    const stopping = h.service.stop(); // user's Stop in flight…
    expect(h.service.busy).toBe(true);
    await h.service.shutdown(); // …and the app quits
    const rows = await h.service.audioStore.list({ meetingId });
    expect(rows.map((r) => r.status)).toEqual(['complete', 'complete']);
    expect(h.service.busy).toBe(false);
    expect(h.service.stop()).not.toBe(stopping); // the old stop is done
    await stopping;
  });

  it('a session that ended by itself is busy until its files are closed', async () => {
    const h = setup({ durationMs: 2_000 });
    const { meetingId } = await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    // Right at idle the files may still be closing: shutdown waits for them.
    await h.service.shutdown();
    expect(h.service.busy).toBe(false);
    const rows = await h.service.audioStore.list({ meetingId });
    expect(rows.map((r) => r.status)).toEqual(['complete', 'complete']);
  });

  it('a second stop shares the first; two concurrent starts → only one runs', async () => {
    const h = setup({ speed: 'realtime' });
    const [first, second] = await Promise.allSettled([
      h.service.start({ spec: fixture }),
      h.service.start({ spec: fixture }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'invalid_state' } });
    await h.waitFor('recording');
    const a = h.service.stop();
    expect(h.service.stop()).toBe(a);
    expect((await a).audio).toHaveLength(2);
  });
});

describe('RecordingService: system sleep (review 2.5 #2)', () => {
  function fakePower() {
    const listeners = { suspend: [] as (() => void)[], resume: [] as (() => void)[] };
    return {
      power: {
        on: (event: 'suspend' | 'resume', fn: () => void) => listeners[event].push(fn),
      } satisfies PowerEvents,
      emit: (event: 'suspend' | 'resume') => listeners[event].forEach((fn) => fn()),
    };
  }

  it('suspend pauses with a visible note; resume carries on; elapsed excludes the sleep', async () => {
    const { power, emit } = fakePower();
    const h = setup({ speed: 'realtime', power });
    await h.service.start({ spec: fixture });
    await h.waitFor('recording');
    await new Promise((r) => setTimeout(r, 400));

    emit('suspend');
    expect(h.service.status).toBe('paused');
    const asleep = h.service.snapshot();
    expect(asleep.issues).toEqual([
      expect.objectContaining({
        scope: 'audio',
        code: 'system_sleep',
        fatal: false,
        message: 'Paused while your Mac was asleep.',
      }),
    ]);
    await new Promise((r) => setTimeout(r, 600)); // "asleep"
    expect(h.service.snapshot().elapsedMs).toBe(asleep.elapsedMs);

    emit('resume');
    expect(h.service.status).toBe('recording');
    const awake = h.service.snapshot();
    expect(awake.issues).toHaveLength(1); // still visible
    expect(awake.issues[0]!.message).toMatch(/asleep \(1 min\); nothing was recorded then/);
    await new Promise((r) => setTimeout(r, 300));
    const elapsed = h.service.snapshot().elapsedMs;
    // ~400 ms before + ~300 ms after; the 600 ms of sleep are not counted.
    expect(elapsed).toBeGreaterThan(550);
    expect(elapsed).toBeLessThan(1_100);
    const result = await h.service.stop();
    expect(result.audio.every((a) => a.status === 'complete')).toBe(true);
  });

  it('a recording paused by hand stays paused after wake; idle ignores sleep', async () => {
    const { power, emit } = fakePower();
    const h = setup({ speed: 'realtime', power });
    emit('suspend');
    emit('resume');
    expect(h.service.status).toBe('idle');
    await h.service.start({ spec: fixture });
    await h.waitFor('recording');
    h.service.pause();
    emit('suspend');
    emit('resume');
    expect(h.service.status).toBe('paused');
    expect(h.service.snapshot().issues).toEqual([]);
    await h.service.stop();
  });
});

describe('RecordingService + local database (2.6)', () => {
  function localDb(withWorkspace = true) {
    const store = new LocalStore({ path: ':memory:' });
    if (withWorkspace) {
      store.applyPull(
        {
          changes: [
            { op: 'upsert', table: 'workspace', row: { id: 'ws', name: 'Me', kind: 'personal' } },
          ],
          cursor: 'c',
          hasMore: false,
          workspaceIds: ['ws'],
        },
        null,
      );
    }
    let kicks = 0;
    const persistence = new MeetingPersistence({
      store: () => store,
      userId: () => 'u1',
      workspaceTimeoutMs: 10,
      sync: {
        kick: () => void kicks++,
        personalWorkspace: async () => store.personalWorkspaceId(),
      },
    });
    return { store, persistence, kicks: () => kicks };
  }

  it('finals, the meeting and its audio rows land in SQLite as they happen; interims never do', async () => {
    const db = localDb();
    const audio = new AudioIndex({ path: ':memory:' });
    const h = setup({ persistence: db.persistence, store: audio });
    const { meetingId } = await h.service.start({ spec: fixture });
    const meetingRow = db.store.meeting(meetingId)!;
    expect(meetingRow.startedAt).not.toBeNull();
    expect(db.store.document(meetingRow.documentId)).toMatchObject({
      kind: 'meeting',
      workspaceId: 'ws',
      ownerId: 'u1',
      visibility: 'private',
    });
    await h.waitFor('idle');
    await h.service.stop();

    const finals = h.service
      .transcript()
      .segments.filter((s) => s.isFinal)
      .map((s) => [s.id, s.text])
      .sort();
    const stored = db.store
      .segments(meetingId)
      .map((s) => [s.id, s.text])
      .sort();
    expect(finals.length).toBeGreaterThan(5);
    expect(stored).toEqual(finals);
    expect(db.store.meeting(meetingId)!.endedAt).not.toBeNull();
    const rows = await audio.list({ meetingId });
    expect(rows.map((a) => [a.source, a.status])).toEqual([
      ['mic', 'complete'],
      ['system', 'complete'],
    ]);
    // Everything is queued for the server: document, meeting, every final.
    const queued = db.store.outbox();
    expect(queued.filter((e) => e.table === 'transcript_segment')).toHaveLength(stored.length);
    expect(queued.map((e) => e.table)).toEqual(expect.arrayContaining(['document', 'meeting']));
    expect(db.kicks()).toBeGreaterThan(stored.length);
    db.store.close();
  });

  it('no workspace known (fresh cache, offline): the start fails visibly', async () => {
    const db = localDb(false);
    const h = setup({ persistence: db.persistence });
    await expect(h.service.start({ spec: fixture })).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/connect once/),
    });
    expect(h.service.status).toBe('idle');
    db.store.close();
  });

  it('a store failure becomes an issue; recording and the live transcript carry on', async () => {
    const failing: TranscriptPersistence = {
      beginMeeting: async () => {},
      saveSegment: () => {
        throw new Error('disk I/O error');
      },
      endMeeting: () => {},
    };
    const h = setup({ persistence: failing });
    await h.service.start({ spec: fixture });
    await h.waitFor('idle');
    const issues = h.service.snapshot().issues.filter((i) => i.code === 'transcript_store_failed');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.count).toBeGreaterThan(1);
    expect(h.service.transcript().segments.length).toBeGreaterThan(5);
    await h.service.stop();
  });
});
