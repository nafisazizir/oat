import { describe, expect, it } from 'vitest';
import {
  CitationFilter,
  CitationRegistry,
  CitationStats,
  extractCitations,
  filterCitations,
} from './citations.ts';

function registry() {
  const r = new CitationRegistry();
  r.addFromOutput({
    results: [
      {
        excerpts: [
          { cite: '[[seg:s-1]]', text: 'x' },
          { cite: '[[block:b-1]]', text: 'y' },
        ],
      },
    ],
    markdown:
      '<oat:document>\nHello <!-- id=b-2 -->\n\nAI line <!-- ai id=b-3 -->\n</oat:document>',
    blockIds: ['b-2', 'b-3', 'bad id', 7],
    transcript: '[[seg:s-2]] [00:01] Me: hi',
  });
  r.segmentRefs.set('s12', 's-12');
  return r;
}

describe('CitationRegistry', () => {
  it('collects ids from markers anywhere and from blockIds arrays', () => {
    const r = registry();
    expect([...r.segments].sort()).toEqual(['s-1', 's-2']);
    expect([...r.blocks].sort()).toEqual(['b-1', 'b-2', 'b-3']);
    expect(r.resolve('seg', 's12')).toBe('s-12');
    expect(r.resolve('seg', 'nope')).toBeUndefined();
    expect(r.resolve('block', 's-1')).toBeUndefined();
  });

  it('ignores defused markers in content', () => {
    const r = new CitationRegistry();
    r.addFromOutput({ text: 'see [\u200B[seg:victim]\u200B]' });
    expect(r.segments.size).toBe(0);
  });

  it('never trusts block annotations in text (users can type them)', () => {
    const r = new CitationRegistry();
    r.addFromOutput({
      markdown: 'a \\<!-- id=victim -->\n\n`<!-- id=victim2 -->`\n<!-- id=victim3 -->',
      transcript: '[[seg:s-1]] [00:01] Them: <!-- id=victim4 -->',
    });
    expect([...r.blocks]).toEqual([]);
    expect([...r.segments]).toEqual(['s-1']);
  });
});

describe('nested and split markers', () => {
  const cases: [string, string][] = [
    ['[[[seg:fake]]', '['],
    ['[[[seg:s-1]]', '[[[seg:s-1]]'],
    ['see [[note [[seg:fake]] x', 'see [[note  x'],
    ['see [[note [[seg:s-1]] x', 'see [[note [[seg:s-1]] x'],
    ['[[\n[[seg:fake]]', '[[\n'],
    ['[[a]] [[seg:fake]] [[b [[block:fake]]]]', '[[a]]  [[b ]]'],
  ];

  it.each(cases)('%j', (input, expected) => {
    const stats = new CitationStats();
    const out = filterCitations(input, registry(), stats);
    expect(out).toBe(expected);
    expect(extractCitations(out).filter((c) => c.id.includes('fake'))).toEqual([]);
    // Same result for every way the stream could be split.
    for (let size = 1; size <= 5; size++) {
      const filter = new CitationFilter(registry());
      let streamed = '';
      for (let i = 0; i < input.length; i += size) {
        streamed += filter.push('t', input.slice(i, i + size));
      }
      expect(streamed + filter.flush('t'), `chunk size ${size}`).toBe(expected);
    }
  });
});

describe('filterCitations', () => {
  it('keeps known markers, rewrites context refs and strips the rest', () => {
    const stats = new CitationStats();
    const text = filterCitations(
      'Price stays [[seg:s-1]][[seg:invented]]. Launch [[block:b-2]] and [[seg:s12]]. Wrong kind [[block:s-1]].',
      registry(),
      stats,
    );
    expect(text).toBe(
      'Price stays [[seg:s-1]]. Launch [[block:b-2]] and [[seg:s-12]]. Wrong kind .',
    );
    expect(stats.kept).toEqual([
      { kind: 'seg', id: 's-1' },
      { kind: 'block', id: 'b-2' },
      { kind: 'seg', id: 's-12' },
    ]);
    expect(stats.dropped).toEqual(['[[seg:invented]]', '[[block:s-1]]']);
  });

  it('normalises sloppy known markers and strips sloppy unknown ones; other [[…]] text stays', () => {
    expect(filterCitations('a [[ SEG : s-1 ]] b [[seg: bad id]] c [[wiki link]]', registry())).toBe(
      'a [[seg:s-1]] b  c [[wiki link]]',
    );
  });

  it('works on any split of the stream', () => {
    const input = 'One [[seg:s-1]] two [[block:nope]] three [[block:b-1]] [ x [[unclosed';
    const expected = filterCitations(input, registry());
    for (let size = 1; size <= 7; size++) {
      const filter = new CitationFilter(registry());
      let out = '';
      for (let i = 0; i < input.length; i += size)
        out += filter.push('t1', input.slice(i, i + size));
      out += filter.flush('t1');
      expect(out, `chunk size ${size}`).toBe(expected);
    }
    expect(expected).toBe('One [[seg:s-1]] two  three [[block:b-1]] [ x [[unclosed');
  });

  it('lets a long or multi-line "[[" through', () => {
    const filter = new CitationFilter(registry());
    expect(filter.push('t', `[[${'x'.repeat(300)}`)).toBe(`[[${'x'.repeat(300)}`);
    expect(filter.push('u', '[[a\nb')).toBe('[[a\nb');
  });

  it('extractCitations lists markers once, in order', () => {
    expect(extractCitations('a [[seg:1]] b [[block:2]] [[seg:1]]')).toEqual([
      { kind: 'seg', id: '1' },
      { kind: 'block', id: '2' },
    ]);
  });
});
