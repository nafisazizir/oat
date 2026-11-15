/**
 * DeepgramProvider against the Deepgram-compatible mock (`tools/mocks` stt provider), in-process via
 * `startMocks()`: this checkout's mock code, private state, loopback only (D-11).
 */
import { startMocks, type RunningMocks } from '@oat/mocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeSttContract } from './contract.testsuite.ts';
import { DeepgramProvider, type DeepgramProviderOptions } from './deepgram.ts';
import { grantTokenSource, resolveDeepgramEndpoints } from './deepgram-config.ts';
import {
  finals,
  finalText,
  groundTruth,
  interims,
  pipeFixture,
  record,
  truthText,
} from './test-utils.ts';

let mocks: RunningMocks;
beforeAll(async () => {
  mocks = await startMocks();
});
afterAll(() => mocks.close());

const truth = groundTruth('standup-short');

function deepgram(
  fixture: string | undefined,
  sliceStartMs = 0,
  extra: Record<string, string | number> = {},
  options: Partial<DeepgramProviderOptions> = {},
): DeepgramProvider {
  const endpoints = resolveDeepgramEndpoints({ MOCKS_URL: mocks.url });
  return new DeepgramProvider({
    url: endpoints.listenUrl,
    getToken: grantTokenSource({ grantUrl: endpoints.grantUrl }),
    reconnect: { initialDelayMs: 20, maxDelayMs: 200 },
    extraQuery: ({ source, offsetMs }) => ({
      ...(fixture
        ? { mock_fixture: fixture, mock_channel: source, mock_offset_ms: offsetMs ?? sliceStartMs }
        : {}),
      ...extra,
    }),
    ...options,
  });
}

const upgrades = (since: number, query: Record<string, string>) =>
  mocks.log
    .list({ provider: 'stt', since })
    .filter(
      (r) =>
        r.path === '/stt/v1/listen' && Object.entries(query).every(([k, v]) => r.query[k] === v),
    );

describeSttContract('DeepgramProvider ↔ mock', {
  provider: ({ fixture, sliceStartMs }) => deepgram(fixture, sliceStartMs),
});

describe('DeepgramProvider ↔ mock', () => {
  it('sends Deepgram live params and a bearer token from the grant endpoint', async () => {
    const since = mocks.log.list().at(-1)?.id ?? 0;
    const rec = record(
      deepgram(undefined).openStream({
        source: 'mic',
        sampleRate: 16_000,
        language: 'en',
        keyterms: ['Priya'],
      }),
    );
    await rec.stream.finish();
    const [grant, listen] = mocks.log.list({ provider: 'stt', since });
    expect(grant).toMatchObject({ method: 'POST', path: '/stt/v1/auth/grant', status: 200 });
    expect(listen).toMatchObject({
      path: '/stt/v1/listen',
      status: 101,
      query: {
        model: 'nova-3',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        interim_results: 'true',
        smart_format: 'true',
        endpointing: '300',
        mip_opt_out: 'true',
        language: 'en',
        keyterm: 'Priya',
      },
    });
    expect(listen!.headers.authorization).toBe('Bearer [redacted]');
    expect(Object.keys(listen!.query).some((k) => k.startsWith('mock_'))).toBe(false);
  });

  it('realtime: frame write → first transcript under 1.5 s (5 s slice)', async () => {
    const sliceStartMs = 8_000;
    const sliceEndMs = 13_000;
    const records = await pipeFixture(deepgram('standup-short', sliceStartMs), {
      fixture: 'standup-short',
      speed: 'realtime',
      startMs: sliceStartMs,
      durationMs: sliceEndMs - sliceStartMs,
    });
    const latencies: number[] = [];
    for (const source of ['mic', 'system'] as const) {
      const rec = records[source];
      // (a) Speech onset → first segment showing it.
      for (const t of truth) {
        if (t.source !== source || t.startMs < sliceStartMs || t.startMs + 1_500 > sliceEndMs) {
          continue;
        }
        const written = rec.writes.find((w) => w.endUs / 1000 > t.startMs)!.at;
        const i = rec.segments.findIndex((s) => s.endMs > t.startMs);
        expect(i, `no transcript for "${t.text}"`).toBeGreaterThanOrEqual(0);
        latencies.push(rec.arrivals[i]! - written);
      }
      // (b) Every interim: its newest word (by midpoint; word ends can run past the audio heard so far)
      // was written < 1.5 s before the interim arrived.
      rec.segments.forEach((s, i) => {
        const last = s.words?.at(-1);
        if (s.isFinal || !last) return;
        const mid = (last.startMs + last.endMs) / 2;
        const written = rec.writes.find((w) => w.endUs / 1000 >= mid)?.at;
        if (written !== undefined) latencies.push(rec.arrivals[i]! - written);
      });
      expect(interims(rec).length).toBeGreaterThan(0);
    }
    expect(latencies.length).toBeGreaterThan(3);
    expect(Math.max(...latencies)).toBeLessThan(1_500);
  }, 20_000);

  it('forced disconnect mid-stream: reconnects, replays, no lost or duplicate finals', async () => {
    const since = mocks.log.list().at(-1)?.id ?? 0;
    const records = await pipeFixture(
      deepgram('standup-short', 0, { drop_after_ms: 9_000, mock_session: 'drop-test' }),
      { fixture: 'standup-short' },
    );
    for (const source of ['mic', 'system'] as const) {
      const rec = records[source];
      expect(rec.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed']);
      expect(rec.errors).toMatchObject([{ code: 'connection', fatal: false }]);
      expect(finalText(rec)).toBe(truthText(truth, source));
      const fs = finals(rec);
      for (let i = 1; i < fs.length; i++) {
        expect(fs[i]!.startMs).toBeGreaterThanOrEqual(fs[i - 1]!.endMs - 1);
      }
      const dials = upgrades(since, { mock_channel: source, mock_session: 'drop-test' });
      expect(dials).toHaveLength(2);
      // The second connection resumed from the last finalized audio, not from 0 and not after the drop.
      const resumeMs = Number(dials[1]!.query.mock_offset_ms);
      expect(resumeMs).toBeGreaterThan(0);
      expect(resumeMs).toBeLessThanOrEqual(9_000);
    }
  });

  it('reports audio that fell out of a too-small replay buffer', async () => {
    const records = await pipeFixture(
      deepgram(
        'standup-short',
        0,
        { drop_after_ms: 9_000, mock_session: 'overflow-test' },
        { replayBufferMs: 1_000, reconnect: { initialDelayMs: 300, maxDelayMs: 300 } },
      ),
      { fixture: 'standup-short' },
    );
    const overflow = records.mic.errors.find((e) => e.code === 'replay_overflow');
    expect(overflow).toMatchObject({ fatal: false });
    expect(overflow!.lostFromMs).toBeLessThanOrEqual(9_000);
    expect(overflow!.lostToMs).toBeGreaterThan(overflow!.lostFromMs!);
  });

  it('auth rejection surfaces a fatal auth error and status error', async () => {
    const rec = record(
      deepgram(undefined, 0, { reject_auth: 1 }).openStream({ source: 'mic', sampleRate: 16_000 }),
    );
    await new Promise<void>((resolve) =>
      rec.stream.on('status', (s) => s === 'error' && resolve()),
    );
    expect(rec.statuses).toEqual(['connecting', 'reconnecting', 'error']);
    expect(rec.errors.map((e) => [e.code, e.fatal, e.status])).toEqual([
      ['auth', false, 401],
      ['auth', true, 401],
    ]);
    await rec.stream.finish();
  });

  it('a bad token is rejected by the handshake', async () => {
    const rec = record(
      new DeepgramProvider({
        url: resolveDeepgramEndpoints({ MOCKS_URL: mocks.url }).listenUrl,
        getToken: () => Promise.resolve({ token: 'forged' }),
        authRetries: 0,
      }).openStream({ source: 'mic', sampleRate: 16_000 }),
    );
    await new Promise<void>((resolve) =>
      rec.stream.on('status', (s) => s === 'error' && resolve()),
    );
    expect(rec.errors).toMatchObject([{ code: 'auth', fatal: true, status: 401 }]);
  });

  it('sends KeepAlive while no audio flows, so an idle provider does not drop the stream', async () => {
    // Mock idle timeout 1.5 s, pause 3.5 s; KeepAlive every 200 ms leaves > 1 s of margin.
    const pcm = new Int16Array(320);
    const run = async (opts: Partial<DeepgramProviderOptions>) => {
      const rec = record(
        deepgram(undefined, 0, { mock_idle_timeout_ms: 1_500 }, opts).openStream({
          source: 'mic',
          sampleRate: 16_000,
        }),
      );
      rec.stream.write({ source: 'mic', tUs: 0, pcm, sampleRate: 16_000 });
      await new Promise((r) => setTimeout(r, 3_500)); // paused: no audio
      await rec.stream.finish();
      return rec;
    };
    const [kept, dropped] = await Promise.all([
      run({ keepAliveMs: 200 }),
      // Control: neither KeepAlive nor the pause Finalize (which also counts as a message).
      run({ keepAliveMs: 60_000, pauseFinalizeMs: 60_000 }),
    ]);
    expect(kept.statuses).toEqual(['connecting', 'open', 'closed']);
    expect(kept.errors).toEqual([]);
    expect(dropped.statuses).toContain('reconnecting');
    expect(dropped.errors[0]).toMatchObject({ code: 'connection', status: 1011 });
  }, 15_000);

  it('a pause longer than the stall window: no stall/redial, the utterance before it is finalized', async () => {
    let resumedAt = Infinity;
    let paused = false;
    const records = await pipeFixture(
      deepgram(
        'standup-short',
        0,
        {},
        {
          stallTimeoutMs: 1_500,
          pauseFinalizeMs: 300,
          keepAliveMs: 500,
        },
      ),
      {
        fixture: 'standup-short',
        speed: 'realtime',
        durationMs: 4_500,
        onFrame: (source, tUs, audio) => {
          if (paused || source !== 'system' || tUs < 2_500_000) return;
          paused = true;
          audio.pause();
          setTimeout(() => {
            resumedAt = performance.now();
            audio.resume();
          }, 3_000);
        },
      },
    );
    const mic = records.mic;
    expect(mic.errors).toEqual([]);
    expect(records.system.errors).toEqual([]);
    expect(mic.statuses).toEqual(['connecting', 'open', 'closed']);
    // "Morning, everyone. Let's keep…" (0.5–4.3 s) was mid-utterance at the pause; Finalize made the
    // words heard so far final while still paused.
    const i = mic.segments.findIndex((s) => s.isFinal && /Morning/.test(s.text));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(mic.arrivals[i]!).toBeLessThan(resumedAt);
    expect(mic.segments[i]!.endMs).toBeLessThanOrEqual(2_600);
  }, 20_000);

  it('redials when the provider goes silent while audio flows (stall)', async () => {
    const provider = deepgram(
      undefined,
      0,
      { latency_ms: 5_000, mock_session: 'stall' },
      { stallTimeoutMs: 300 },
    );
    const rec = record(provider.openStream({ source: 'system', sampleRate: 16_000 }));
    const pcm = new Int16Array(320).fill(4000);
    let i = 0;
    // Audio keeps flowing (realtime pace) while the provider's replies are 5 s late.
    const writer = setInterval(
      () => rec.stream.write({ source: 'system', tUs: i++ * 20_000, pcm, sampleRate: 16_000 }),
      20,
    );
    try {
      await new Promise<void>((resolve) =>
        rec.stream.on('error', (e) => e.code === 'stall' && resolve()),
      );
    } finally {
      clearInterval(writer);
    }
    expect(rec.errors[0]).toMatchObject({ code: 'stall', fatal: false });
    rec.stream.close();
  });
});
