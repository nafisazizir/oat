import type {
  OatBridge,
  RecordingSnapshot,
  TranscriptBatch,
  LiveSegment,
  TranscriptSnapshot,
} from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { createRecordingClient, createTranscriptClient, retryDelay } from './recording-state.ts';
import {
  elapsedNow,
  isActive,
  isNearBottom,
  levelFill,
  startsGroup,
  transcriptionHealth,
} from './recording-view.ts';

/** A bridge whose invoke replies are released by the test and whose pushes are triggered by it. */
function fakeBridge() {
  const pushers = new Map<string, (payload: unknown) => void>();
  const replies: { channel: string; resolve: (value: unknown) => void }[] = [];
  const oat = {
    invoke: (channel: string) =>
      new Promise((resolve) =>
        replies.push({ channel, resolve: (v) => resolve({ ok: true, value: v }) }),
      ),
    subscribe: (channel: string, listener: (payload: unknown) => void) => {
      pushers.set(channel, listener);
      return () => pushers.delete(channel);
    },
  } as unknown as Pick<OatBridge, 'invoke' | 'subscribe'>;
  return {
    oat,
    push: (channel: string, payload: unknown) => pushers.get(channel)!(payload),
    reply: async (channel: string, value: unknown) => {
      const i = replies.findIndex((r) => r.channel === channel);
      replies.splice(i, 1)[0]!.resolve(value);
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: (channel: string) => replies.filter((r) => r.channel === channel).length,
  };
}

const rec = (seq: number, overrides: Partial<RecordingSnapshot> = {}): RecordingSnapshot => ({
  seq,
  status: 'idle',
  meetingId: null,
  input: null,
  fixture: null,
  startedAt: null,
  elapsedMs: 0,
  elapsedAt: 0,
  levels: { mic: null, system: null },
  stt: { mic: 'idle', system: 'idle' },
  issues: [],
  ...overrides,
});

const seg = (id: string, text: string, isFinal: boolean, startMs = 0): LiveSegment => ({
  id,
  source: 'mic',
  startMs,
  endMs: startMs + 500,
  text,
  isFinal,
});
const batch = (meetingId: string, seq: number, segments: LiveSegment[]): TranscriptBatch => ({
  meetingId,
  seq,
  segments,
});

describe('createRecordingClient', () => {
  it('keeps the newest snapshot; a reply may refresh the same seq, a push may not', async () => {
    const fake = fakeBridge();
    const client = createRecordingClient(fake.oat);
    fake.push('recording:state', rec(3, { status: 'recording' }));
    await fake.reply('recording:get', rec(2)); // stale reply
    expect(client.getSnapshot()!.status).toBe('recording');
    await client.ready;
    fake.push('recording:state', rec(3, { status: 'paused' })); // duplicate seq push: ignored
    expect(client.getSnapshot()!.status).toBe('recording');
    fake.push('recording:state', rec(4, { status: 'paused' }));
    expect(client.getSnapshot()!.status).toBe('paused');
  });
});

describe('createTranscriptClient', () => {
  it('loads the snapshot, then applies only the batches after it', async () => {
    const fake = fakeBridge();
    const client = createTranscriptClient(fake.oat);
    expect(client.getSnapshot().loaded).toBe(false);
    // Batches overtaking the reply are held…
    fake.push('transcript:segments', batch('m', 2, [seg('a', 'hello there', true)]));
    fake.push('transcript:segments', batch('m', 3, [seg('b', 'how', false, 1000)]));
    const snapshot: TranscriptSnapshot = {
      meetingId: 'm',
      seq: 2,
      segments: [seg('a', 'hello there', true)],
    };
    await fake.reply('transcript:get', snapshot);
    // …and only seq 3 is applied on top of the snapshot.
    expect(client.getSnapshot()).toEqual({
      meetingId: 'm',
      loaded: true,
      failed: false,
      segments: [seg('a', 'hello there', true), seg('b', 'how', false, 1000)],
    });
    fake.push('transcript:segments', batch('m', 4, [seg('b', 'how are you', true, 1000)]));
    expect(client.getSnapshot().segments.at(-1)).toEqual(seg('b', 'how are you', true, 1000));
    fake.push('transcript:segments', batch('m', 5, [seg('b', '', true, 1000)])); // retraction
    expect(client.getSnapshot().segments.map((s) => s.id)).toEqual(['a']);
  });

  it('a new meeting (seq 1) replaces the transcript', async () => {
    const fake = fakeBridge();
    const client = createTranscriptClient(fake.oat);
    await fake.reply('transcript:get', {
      meetingId: 'old',
      seq: 7,
      segments: [seg('x', 'old', true)],
    });
    fake.push('transcript:segments', batch('new', 1, [seg('y', 'new', false)]));
    expect(client.getSnapshot()).toMatchObject({
      meetingId: 'new',
      segments: [seg('y', 'new', false)],
    });
  });

  it('a gap reloads the snapshot instead of showing a wrong transcript', async () => {
    const fake = fakeBridge();
    const client = createTranscriptClient(fake.oat);
    await fake.reply('transcript:get', {
      meetingId: 'm',
      seq: 1,
      segments: [seg('a', 'one', true)],
    });
    fake.push('transcript:segments', batch('m', 3, [seg('c', 'three', true, 2000)])); // 2 was missed
    expect(fake.pending('transcript:get')).toBe(1);
    await fake.reply('transcript:get', {
      meetingId: 'm',
      seq: 3,
      segments: [seg('a', 'one', true), seg('b', 'two', true, 1000), seg('c', 'three', true, 2000)],
    });
    expect(client.getSnapshot().segments.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createTranscriptClient: load failures', () => {
  it('a failed transcript:get is shown and retried with backoff until it works', async () => {
    const answers: (() => Promise<unknown>)[] = [
      async () => ({ ok: false, error: { code: 'internal', message: 'boom' } }),
      () => Promise.reject(new Error('ipc gone')),
      async () => ({
        ok: true,
        value: { meetingId: 'm', seq: 1, segments: [seg('a', 'hi', true)] },
      }),
    ];
    const timers: { fn: () => void; ms: number }[] = [];
    const oat = {
      invoke: () => answers.shift()!(),
      subscribe: () => () => {},
    } as unknown as Pick<OatBridge, 'invoke' | 'subscribe'>;
    const client = createTranscriptClient(oat, (fn, ms) => timers.push({ fn, ms }));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    await flush();
    expect(client.getSnapshot()).toMatchObject({ loaded: false, failed: true });
    expect(timers.map((t) => t.ms)).toEqual([500]);
    timers.shift()!.fn();
    await flush();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers.shift()!.fn();
    await flush();
    expect(client.getSnapshot()).toMatchObject({
      loaded: true,
      failed: false,
      segments: [seg('a', 'hi', true)],
    });
    expect(timers).toEqual([]);
    expect(retryDelay(10)).toBe(10_000);
  });
});

describe('recording view helpers', () => {
  it('transcriptionHealth: worst stream wins; idle/closed streams do not count', () => {
    expect(transcriptionHealth({ mic: 'idle', system: 'idle' })).toBe('off');
    expect(transcriptionHealth({ mic: 'open', system: 'open' })).toBe('live');
    expect(transcriptionHealth({ mic: 'open', system: 'idle' })).toBe('live');
    expect(transcriptionHealth({ mic: 'open', system: 'connecting' })).toBe('connecting');
    expect(transcriptionHealth({ mic: 'reconnecting', system: 'connecting' })).toBe('reconnecting');
    expect(transcriptionHealth({ mic: 'error', system: 'open' })).toBe('offline');
    expect(transcriptionHealth({ mic: 'closed', system: 'closed' })).toBe('off');
  });

  it('levelFill maps −60…0 dBFS to 0…1', () => {
    expect(levelFill(-100)).toBe(0);
    expect(levelFill(-30)).toBe(0.5);
    expect(levelFill(3)).toBe(1);
    expect(levelFill(null)).toBe(0);
  });

  it('elapsedNow ticks only while recording', () => {
    const s = rec(1, { status: 'recording', elapsedMs: 5000, elapsedAt: 1000 });
    expect(elapsedNow(s, 3500)).toBe(7500);
    expect(elapsedNow({ ...s, status: 'paused' }, 3500)).toBe(5000);
    expect(elapsedNow(null, 1)).toBe(0);
  });

  it('isActive / startsGroup / isNearBottom', () => {
    expect(isActive('paused')).toBe(true);
    expect(isActive('stopping')).toBe(false);
    const a = seg('a', 'x', true, 0);
    expect(startsGroup(a, undefined)).toBe(true);
    expect(startsGroup(seg('b', 'y', true, 1000), a)).toBe(false);
    expect(startsGroup({ ...seg('b', 'y', true, 1000), source: 'system' }, a)).toBe(true);
    expect(startsGroup(seg('b', 'y', true, 40_000), a)).toBe(true);
    expect(isNearBottom({ scrollTop: 560, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });
});
