/**
 * The `SttProvider` contract. Every provider (Fake in unit tests, Deepgram against the mock in int tests)
 * runs this same suite, so consumers (2.6) can rely on it whichever provider is configured.
 */
import { AUDIO_SOURCES } from '@oat/audio';
import { describe, expect, it } from 'vitest';

import {
  finals,
  groundTruth,
  interims,
  finalText,
  normalize,
  pipeFixture,
  record,
  truthText,
} from './test-utils.ts';
import type { SttProvider } from './types.ts';

export interface ContractHarness {
  /**
   * A provider that transcribes `fixture` (Fake: from its ground truth; Deepgram: against the mock in
   * fixture mode). `sliceStartMs` is where the streamed audio starts on the recording clock.
   */
  provider(ctx: { fixture: string; sliceStartMs: number }): SttProvider | Promise<SttProvider>;
  /** Per-test timeout. Default 15 s. */
  timeoutMs?: number;
}

const FIXTURE = 'standup-short';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOLERANCE_MS = 50;

export function describeSttContract(name: string, harness: ContractHarness): void {
  const timeout = harness.timeoutMs ?? 15_000;
  const truth = groundTruth(FIXTURE);

  describe(`SttProvider contract: ${name}`, () => {
    it(
      'transcribes both sources: tagged, in order, interim before final, text = ground truth',
      async () => {
        const provider = await harness.provider({ fixture: FIXTURE, sliceStartMs: 0 });
        const records = await pipeFixture(provider, { fixture: FIXTURE });

        for (const source of AUDIO_SOURCES) {
          const rec = records[source];
          expect(rec.statuses[0]).toBe('connecting');
          expect(rec.statuses).toContain('open');
          expect(rec.statuses.at(-1)).toBe('closed');
          expect(rec.errors.filter((e) => e.fatal)).toEqual([]);
          expect(rec.segments.every((s) => s.source === source)).toBe(true);

          // Same words as the ground truth, nothing lost or duplicated.
          expect(finalText(rec)).toBe(truthText(truth, source));

          // Finals are ordered and never overlap; timestamps are sane.
          const fs = finals(rec);
          for (const [i, s] of fs.entries()) {
            expect(s.startMs).toBeLessThanOrEqual(s.endMs);
            if (i > 0) expect(s.startMs).toBeGreaterThanOrEqual(fs[i - 1]!.endMs - 1);
          }
          // Recording clock: every final lies on a ground-truth segment of its source.
          for (const s of fs) {
            const hit = truth.some(
              (t) =>
                t.source === source &&
                s.startMs < t.endMs + TOLERANCE_MS &&
                s.endMs > t.startMs - TOLERANCE_MS,
            );
            expect(hit, `final "${s.text}" at ${s.startMs}–${s.endMs}`).toBe(true);
          }

          // Identity (D-19): UUIDv7 ids; interims share the id of the final (or retraction) that closes
          // them and come before it; each final id is used once; nothing is left provisional at the end.
          expect(interims(rec).length).toBeGreaterThan(0);
          const closedAt = new Map<string, number>();
          rec.segments.forEach((s, i) => {
            expect(s.id).toMatch(UUID_V7);
            if (!s.isFinal) return;
            expect(closedAt.has(s.id), `final id ${s.id} reused`).toBe(false);
            closedAt.set(s.id, i);
          });
          let openId: string | undefined;
          rec.segments.forEach((s, i) => {
            if (s.isFinal) {
              if (openId !== undefined) expect(s.id).toBe(openId);
              openId = undefined;
              return;
            }
            if (openId !== undefined) expect(s.id).toBe(openId); // one open interim at a time
            openId = s.id;
            expect(closedAt.get(s.id)).toBeGreaterThan(i);
          });
          expect(openId).toBeUndefined();
        }
      },
      timeout,
    );

    it(
      'keeps recording-clock timestamps for a slice that does not start at 0',
      async () => {
        const sliceStartMs = 8_000;
        const sliceEndMs = 18_000;
        const provider = await harness.provider({ fixture: FIXTURE, sliceStartMs });
        const records = await pipeFixture(provider, {
          fixture: FIXTURE,
          startMs: sliceStartMs,
          durationMs: sliceEndMs - sliceStartMs,
        });
        for (const source of AUDIO_SOURCES) {
          const fs = finals(records[source]);
          for (const s of fs) {
            expect(s.startMs).toBeGreaterThanOrEqual(sliceStartMs - TOLERANCE_MS);
            expect(s.endMs).toBeLessThanOrEqual(sliceEndMs + TOLERANCE_MS);
          }
          const text = normalize(fs.map((s) => s.text).join(' '));
          for (const t of truth) {
            if (t.source === source && t.startMs >= sliceStartMs && t.endMs <= sliceEndMs) {
              expect(text).toContain(normalize(t.text));
            }
          }
          expect(fs.length).toBeGreaterThan(0);
        }
      },
      timeout,
    );

    it('rejects frames of another source or rate', async () => {
      const provider = await harness.provider({ fixture: FIXTURE, sliceStartMs: 0 });
      const stream = provider.openStream({ source: 'mic', sampleRate: 16_000 });
      const pcm = new Int16Array(320);
      expect(() => stream.write({ source: 'system', tUs: 0, pcm, sampleRate: 16_000 })).toThrow();
      expect(() => stream.write({ source: 'mic', tUs: 0, pcm, sampleRate: 48_000 })).toThrow();
      stream.close();
    });

    it(
      'close() stops at once: closed, no further events, later writes ignored',
      async () => {
        const provider = await harness.provider({ fixture: FIXTURE, sliceStartMs: 0 });
        const rec = record(provider.openStream({ source: 'mic', sampleRate: 16_000 }));
        const pcm = new Int16Array(320).fill(5000);
        for (let i = 0; i < 50; i++) {
          rec.stream.write({ source: 'mic', tUs: i * 20_000, pcm, sampleRate: 16_000 });
        }
        rec.stream.close();
        expect(rec.stream.status).toBe('closed');
        const seen = rec.segments.length + rec.statuses.length + rec.errors.length;
        rec.stream.write({ source: 'mic', tUs: 1_000_000, pcm, sampleRate: 16_000 });
        await rec.stream.finish(); // resolves after close
        await new Promise((r) => setTimeout(r, 100));
        expect(rec.segments.length + rec.statuses.length + rec.errors.length).toBe(seen);
      },
      timeout,
    );

    it(
      'finish() without audio closes cleanly',
      async () => {
        const provider = await harness.provider({ fixture: FIXTURE, sliceStartMs: 0 });
        const rec = record(provider.openStream({ source: 'system', sampleRate: 16_000 }));
        await rec.stream.finish();
        expect(rec.stream.status).toBe('closed');
        expect(rec.segments).toEqual([]);
        expect(rec.errors).toEqual([]);
      },
      timeout,
    );
  });
}
