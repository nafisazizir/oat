import { describe, expect, it } from 'vitest';
import { chunkTranscript, orderSegments, speakerName } from './chunk-transcript.ts';
import type { SegmentInput } from './types.ts';

/** `n` segments of `everyMs` each, alternating me/them, with ~`words` words. */
function segments(n: number, everyMs = 5000, words = 8): SegmentInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(3, '0')}`,
    source: i % 2 === 0 ? 'mic' : 'system',
    speakerLabel: null,
    startMs: i * everyMs,
    endMs: i * everyMs + everyMs - 200,
    text: Array.from({ length: words }, (_, w) => `word${i}x${w}`).join(' '),
  }));
}

describe('chunkTranscript', () => {
  it('returns nothing without segments or text', () => {
    expect(chunkTranscript([])).toEqual([]);
    expect(chunkTranscript([{ ...segments(1)[0]!, text: '  ' }])).toEqual([]);
  });

  it('labels speakers and joins consecutive segments of the same speaker', () => {
    expect(speakerName({ source: 'mic', speakerLabel: 'x' })).toBe('Me');
    expect(speakerName({ source: 'system', speakerLabel: null })).toBe('Them');
    expect(speakerName({ source: 'system', speakerLabel: 'Ana' })).toBe('Ana');
    const [chunk] = chunkTranscript(
      [
        { id: 'a', source: 'mic', speakerLabel: null, startMs: 0, endMs: 900, text: 'Hello' },
        {
          id: 'b',
          source: 'mic',
          speakerLabel: null,
          startMs: 1000,
          endMs: 1900,
          text: ' there\n',
        },
        { id: 'c', source: 'system', speakerLabel: 'Ana', startMs: 2000, endMs: 2500, text: 'Hi' },
      ],
      { title: 'Standup' },
    );
    expect(chunk).toEqual({
      source: 'transcript',
      ordinal: 0,
      text: 'Transcript · Standup\n\nMe: Hello there\nAna: Hi',
      refIds: ['a', 'b', 'c'],
      startMs: 0,
      endMs: 2500,
      tokenCount: expect.any(Number),
    });
  });

  it('windows by time (60–90 s) with segment-id ranges and overlap', () => {
    const chunks = chunkTranscript(segments(60)); // 5 minutes
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(c.endMs! - c.startMs!).toBeLessThanOrEqual(90_000);
      expect(c.refIds.length).toBeGreaterThan(0);
    }
    for (const c of chunks.slice(0, -1))
      expect(c.endMs! - c.startMs!).toBeGreaterThanOrEqual(60_000);
    // Each window's time range matches its segments.
    const all = segments(60);
    for (const c of chunks) {
      const first = all.find((s) => s.id === c.refIds[0])!;
      const last = all.find((s) => s.id === c.refIds.at(-1))!;
      expect(c.startMs).toBe(first.startMs);
      expect(c.endMs).toBe(last.endMs);
    }
    // Overlap: the next window starts with the previous one's last segment(s), and coverage is complete.
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i - 1]!.refIds).toContain(chunks[i]!.refIds[0]);
    expect(new Set(chunks.flatMap((c) => c.refIds)).size).toBe(60);
  });

  it('closes windows on the token budget when speech is dense', () => {
    const chunks = chunkTranscript(segments(40, 2000, 60), { targetTokens: 300, maxTokens: 400 });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(400 + 10);
    expect(chunks.length).toBeGreaterThan(5);
  });

  it('is prefix-stable: appending segments only changes the last window', () => {
    const before = chunkTranscript(segments(40));
    const after = chunkTranscript(segments(43));
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });

  it('orders by start time then id regardless of input order', () => {
    const shuffled = segments(10).reverse();
    expect(orderSegments(shuffled).map((s) => s.id)).toEqual(segments(10).map((s) => s.id));
    expect(chunkTranscript(shuffled)).toEqual(chunkTranscript(segments(10)));
  });

  it('splits one enormous segment into chunks that all cite it', () => {
    const huge: SegmentInput = {
      id: 'big',
      source: 'system',
      speakerLabel: null,
      startMs: 1000,
      endMs: 600_000,
      text: Array.from({ length: 900 }, (_, i) => `w${i}`).join(' '),
    };
    const chunks = chunkTranscript([
      segments(1)[0]!,
      huge,
      { ...segments(2)[1]!, startMs: 700_000, endMs: 701_000 },
    ]);
    const pieces = chunks.filter((c) => c.refIds.includes('big'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const c of pieces) {
      expect(c.refIds).toEqual(['big']);
      expect(c.startMs).toBe(1000);
      expect(c.endMs).toBe(600_000);
      expect(c.tokenCount).toBeLessThanOrEqual(500);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });
});
