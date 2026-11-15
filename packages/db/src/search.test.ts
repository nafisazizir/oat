import { describe, expect, it } from 'vitest';

import { MAX_QUERY_LENGTH, parseSearchQuery, toSafeHighlight } from './search.ts';

describe('parseSearchQuery', () => {
  it('returns null when there is nothing to search for', () => {
    expect(parseSearchQuery('')).toBeNull();
    expect(parseSearchQuery('   ')).toBeNull();
    expect(parseSearchQuery('!!! -- ""')).toBeNull();
  });

  it('builds a prefix query from plain words (last word as prefix)', () => {
    expect(parseSearchQuery('  plan   budg ')).toEqual({
      text: 'plan budg',
      mode: 'prefix',
      tsquery: `'plan' & 'budg':*`,
    });
  });

  it('keeps only letters and digits in tsquery words (no operator injection)', () => {
    const q = parseSearchQuery(`a'b & c|d !e (f) <-> g:* \\h`);
    expect(q?.tsquery).toBe(`'a' & 'b' & 'c' & 'd' & 'e' & 'f' & 'g' & 'h':*`);
  });

  it('handles non-Latin scripts and accents', () => {
    expect(parseSearchQuery('café 東京')?.tsquery).toBe(`'café' & '東京':*`);
  });

  it('switches to web-search syntax for quotes, exclusions and OR', () => {
    expect(parseSearchQuery('"budget review"')?.mode).toBe('websearch');
    expect(parseSearchQuery('budget -draft')?.mode).toBe('websearch');
    expect(parseSearchQuery('budget or plan')?.mode).toBe('websearch');
    expect(parseSearchQuery('e-mail')?.mode).toBe('prefix');
    expect(parseSearchQuery('orange')?.mode).toBe('prefix');
  });

  it('caps the query length', () => {
    expect(parseSearchQuery('x'.repeat(500))?.text).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe('toSafeHighlight', () => {
  it('escapes everything and only emits <mark>', () => {
    expect(toSafeHighlight('<script>alert("x")</script> & <img src=x>')).toBe(
      '&lt;script&gt;<mark>alert</mark>(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x&gt;',
    );
  });

  it('collapses whitespace and balances stray sentinels', () => {
    expect(toSafeHighlight('  a\n\nb  c')).toBe('a <mark>b c</mark>');
    expect(toSafeHighlight('a b c')).toBe('a b <mark>c</mark>');
  });

  it('never produces a literal <mark> from user text', () => {
    expect(toSafeHighlight('<mark>x</mark>')).toBe('&lt;mark&gt;x&lt;/mark&gt;');
  });
});
