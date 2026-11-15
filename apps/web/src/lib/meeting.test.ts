import { describe, expect, it } from 'vitest';

import { appendLines } from './meeting';
import type { TranscriptLine } from './transcript';

const line = (id: string, startMs: number): TranscriptLine => ({
  id,
  source: 'mic',
  speaker: 'Me',
  startMs,
  text: id,
});

describe('appendLines (live polling)', () => {
  it('keeps what came before the seam and takes the server’s lines from it on', () => {
    const current = [line('a', 0), line('b', 1000), line('c', 2000)];
    // Polled with after=2000: the server re-sends c (maybe corrected) and the new d.
    const fresh = [{ ...line('c', 2000), text: 'c2' }, line('d', 3000)];
    expect(appendLines(current, fresh, 2000).map((l) => [l.id, l.text])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c2'],
      ['d', 'd'],
    ]);
  });

  it('nothing new keeps everything; an empty transcript takes the first lines', () => {
    const current = [line('a', 0), line('b', 1000)];
    expect(appendLines(current, [line('b', 1000)], 1000)).toEqual(current);
    expect(appendLines([], [line('a', 0)], 0)).toEqual([line('a', 0)]);
  });
});
