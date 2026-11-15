import { describe, expect, it } from 'vitest';
import { chunkNotes, type NotesDoc } from './chunk-notes.ts';
import { estimateTokens } from './text.ts';

const text = (t: string) => ({ type: 'text', text: t });
const p = (id: string, t: string): NotesDoc => ({
  type: 'paragraph',
  attrs: { id },
  content: [text(t)],
});
const h = (id: string, level: number, t: string): NotesDoc => ({
  type: 'heading',
  attrs: { id, level },
  content: [text(t)],
});
const doc = (...content: NotesDoc[]): NotesDoc => ({ type: 'doc', content });
/** A sentence of about `tokens` estimated tokens. */
const words = (tokens: number, word = 'alpha') =>
  `${Array.from({ length: Math.ceil((tokens * 4) / (word.length + 1)) }, () => word).join(' ')}.`;

describe('chunkNotes', () => {
  it('returns nothing for an empty document', () => {
    expect(chunkNotes(doc())).toEqual([]);
    expect(chunkNotes(doc(p('a', ''), { type: 'paragraph', attrs: { id: 'b' } }))).toEqual([]);
  });

  it('keeps a short note in one chunk with every block id and a title prefix', () => {
    const chunks = chunkNotes(
      doc(h('h1', 1, 'Agenda'), p('p1', 'Budget review.'), p('p2', 'Hiring plan.')),
      { title: 'Weekly sync' },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      source: 'notes',
      ordinal: 0,
      refIds: ['h1', 'p1', 'p2'],
      startMs: null,
      endMs: null,
      text: 'Weekly sync\n\n# Agenda\n\nBudget review.\n\nHiring plan.',
    });
    expect(chunks[0]!.tokenCount).toBe(estimateTokens(chunks[0]!.text));
  });

  it('starts a new chunk at a heading once the current one is big enough, with the heading path as context', () => {
    const chunks = chunkNotes(
      doc(
        h('h1', 1, 'Project'),
        h('h2', 2, 'Status'),
        p('p1', words(150)),
        h('h3', 2, 'Risks'),
        p('p2', words(150, 'beta')),
        h('h4', 3, 'Vendors'),
        p('p3', 'Small.'),
      ),
      { title: 'Doc' },
    );
    expect(chunks.map((c) => c.refIds)).toEqual([
      ['h1', 'h2', 'p1'],
      ['h3', 'p2'],
      ['h4', 'p3'],
    ]);
    // Context = what's above the chunk's first unit; a heading inside the chunk stays in the body.
    expect(chunks[0]!.text.startsWith('Doc\n\n# Project\n\n## Status')).toBe(true);
    expect(chunks[1]!.text.startsWith('Doc › Project\n\n## Risks')).toBe(true);
    expect(chunks[2]!.text.startsWith('Doc › Project › Risks\n\n### Vendors')).toBe(true);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('merges tiny sections instead of emitting a chunk per heading', () => {
    const chunks = chunkNotes(
      doc(
        h('a', 2, 'One'),
        p('a1', 'x'),
        h('b', 2, 'Two'),
        p('b1', 'y'),
        h('c', 2, 'Three'),
        p('c1', 'z'),
      ),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.refIds).toEqual(['a', 'a1', 'b', 'b1', 'c', 'c1']);
  });

  it('splits a long section near the target size, never over the max, with overlap', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => p(`p${i}`, words(45, `w${i}`)));
    const chunks = chunkNotes(doc(...blocks), {
      targetTokens: 200,
      maxTokens: 250,
      overlapTokens: 60,
    });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(250);
    // Every block is covered, in order.
    const covered = [...new Set(chunks.flatMap((c) => c.refIds))];
    expect(covered).toEqual(blocks.map((b) => b.attrs!.id));
    // Consecutive chunks share their boundary block (overlap ≤ 60 tokens = one 45-token block).
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.refIds[0]).toBe(chunks[i - 1]!.refIds.at(-1));
    }
  });

  it('does not overlap across a section boundary', () => {
    const chunks = chunkNotes(
      doc(h('h1', 1, 'A'), p('p1', words(130)), h('h2', 1, 'B'), p('p2', words(10))),
    );
    expect(chunks.map((c) => c.refIds)).toEqual([
      ['h1', 'p1'],
      ['h2', 'p2'],
    ]);
  });

  it('splits an oversized list into its items, keeping list markup and item ids', () => {
    const item = (id: string, t: string) => ({
      type: 'listItem',
      attrs: { id },
      content: [p(`${id}-p`, t)],
    });
    const list = {
      type: 'bulletList',
      attrs: { id: 'list' },
      content: Array.from({ length: 8 }, (_, i) => item(`li${i}`, words(100, `item${i}`))),
    };
    const chunks = chunkNotes(doc(list), { targetTokens: 220, maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.startsWith('- item0')).toBe(true);
    expect([...new Set(chunks.flatMap((c) => c.refIds))]).toEqual(
      Array.from({ length: 8 }, (_, i) => `li${i}`),
    );
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(300);
  });

  it.each(['bulletList', 'orderedList', 'taskList'])(
    'splits one 10k-char item of a %s without recursing forever',
    (listType) => {
      const itemType = listType === 'taskList' ? 'taskItem' : 'listItem';
      const huge = 'Pasted text that goes on and on. '.repeat(310); // > 10 000 chars
      expect(huge.length).toBeGreaterThan(10_000);
      const list = {
        type: listType,
        attrs: { id: 'list' },
        content: [{ type: itemType, attrs: { id: 'item' }, content: [p('item-p', huge)] }],
      };
      const chunks = chunkNotes(doc(list, p('after', 'Next block.')));
      expect(chunks.length).toBeGreaterThanOrEqual(5);
      for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500);
      expect(chunks[0]!.refIds).toEqual(['item-p']);
      expect(chunks.at(-1)!.refIds).toContain('after');
    },
  );

  it('descends into a huge item with nested blocks, citing the nearest id', () => {
    const big = (w: string) => words(400, w);
    const item = {
      type: 'listItem',
      attrs: { id: 'item' },
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: big('first') }] }, // no id → cites the item
        {
          type: 'bulletList',
          attrs: { id: 'nested' },
          content: [
            { type: 'listItem', attrs: { id: 'n1' }, content: [p('n1-p', big('second'))] },
            { type: 'listItem', attrs: { id: 'n2' }, content: [p('n2-p', big('third'))] },
          ],
        },
      ],
    };
    const chunks = chunkNotes(doc({ type: 'bulletList', attrs: { id: 'l' }, content: [item] }));
    expect([...new Set(chunks.flatMap((c) => c.refIds))]).toEqual(['item', 'n1', 'n2']);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500);
  });

  it('splits a single huge paragraph into pieces that all cite it', () => {
    const chunks = chunkNotes(doc(p('big', words(1200))), { targetTokens: 400, maxTokens: 500 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.refIds).toEqual(['big']);
      expect(c.tokenCount).toBeLessThanOrEqual(500);
    }
  });

  it('is deterministic, and an edit only changes the chunks around it', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => p(`p${i}`, words(60, `t${i}`)));
    const before = chunkNotes(doc(...blocks), { title: 'T' });
    expect(chunkNotes(doc(...blocks), { title: 'T' })).toEqual(before);
    const edited = [...blocks];
    edited[19] = p('p19', words(60, 'changed'));
    const after = chunkNotes(doc(...edited), { title: 'T' });
    expect(after.length).toBe(before.length);
    expect(after.slice(0, -1).map((c) => c.text)).toEqual(before.slice(0, -1).map((c) => c.text));
    expect(after.at(-1)!.text).not.toBe(before.at(-1)!.text);
  });
});
