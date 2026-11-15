import { describe, expect, it } from 'vitest';

import { blockHref, clock, cssString, focusedLine, parseDeepLink, segmentHref } from './transcript';

const lines = [
  { id: 'a', startMs: 0 },
  { id: 'b', startMs: 5_000 },
  { id: 'c', startMs: 12_000 },
];

describe('parseDeepLink', () => {
  it('reads t, seg and block', () => {
    expect(parseDeepLink({ t: '65', seg: 'abc-1', block: 'b_2' })).toEqual({
      t: 65,
      seg: 'abc-1',
      block: 'b_2',
    });
  });

  it('drops malformed values', () => {
    expect(parseDeepLink({ t: '-1', seg: 'a b', block: '<x>' })).toEqual({});
    expect(parseDeepLink({ t: ['7', '9'] })).toEqual({ t: 7 });
  });
});

describe('focusedLine', () => {
  it('prefers the segment, then the line spoken at t', () => {
    expect(focusedLine(lines, { seg: 'c', t: 1 })).toBe('c');
    expect(focusedLine(lines, { seg: 'gone', t: 6 })).toBe('b');
    expect(focusedLine(lines, { t: 100 })).toBe('c');
    expect(focusedLine(lines, {})).toBeUndefined();
    expect(focusedLine([], { t: 3 })).toBeUndefined();
  });
});

describe('links', () => {
  it('builds deep links', () => {
    expect(segmentHref('d1', 65_400, 's 1')).toBe('/d/d1?t=65&seg=s%201');
    expect(blockHref('d1', 'b1')).toBe('/d/d1?block=b1');
  });

  it('formats clock times', () => {
    expect(clock(65_400)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });
});

describe('cssString', () => {
  it('quotes ids for attribute selectors, escaping what could break out', () => {
    expect(cssString('b-1')).toBe('"b-1"');
    expect(cssString('a"]{x}\\')).toBe('"a\\"]{x}\\\\"');
    expect(cssString('a\nb')).toBe('"a b"');
    expect(cssString('</style>')).toBe('"\\3c /style>"');
  });
});
