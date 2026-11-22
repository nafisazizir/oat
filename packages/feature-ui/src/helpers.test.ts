import { describe, expect, it } from 'vitest';

import {
  decodeSearchCursor,
  encodeSearchCursor,
  formatTimestamp,
  highlightParts,
  searchPageHref,
  transcriptHref,
} from './helpers';

describe('highlightParts', () => {
  it('splits on <mark> and decodes entities as text', () => {
    expect(highlightParts('a &lt;b&gt; <mark>c &amp; d</mark> &quot;e&quot;')).toEqual([
      { text: 'a <b> ', mark: false },
      { text: 'c & d', mark: true },
      { text: ' "e"', mark: false },
    ]);
  });

  it('treats anything that is not exactly <mark> as text', () => {
    expect(highlightParts('<img src=x onerror=alert(1)><mark class="x">y')).toEqual([
      { text: '<img src=x onerror=alert(1)><mark class="x">y', mark: false },
    ]);
  });

  it('does not double-decode', () => {
    expect(highlightParts('&amp;lt;')).toEqual([{ text: '&lt;', mark: false }]);
  });
});

describe('cursors', () => {
  it('round-trips offsets and rejects junk', () => {
    expect(decodeSearchCursor(encodeSearchCursor(40))).toBe(40);
    expect(decodeSearchCursor('40')).toBeNull();
    expect(decodeSearchCursor('o-1')).toBeNull();
    expect(decodeSearchCursor('o5000')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats recording offsets', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_400)).toBe('1:05');
    expect(formatTimestamp(3_723_000)).toBe('1:02:03');
  });

  it('builds hrefs', () => {
    expect(transcriptHref({ documentId: 'd1', startMs: 65_400 })).toBe('/d/d1?t=65');
    expect(searchPageHref('a & b')).toBe('/search?q=a+%26+b');
    expect(searchPageHref('x', 'transcripts')).toBe('/search?q=x&tab=transcripts');
  });
});
