import { describe, expect, it } from 'vitest';

import { citationOrder, type MdNode, parseAnswer, safeHref } from './chat-markdown';

/** Compact view of a tree: elements as `tag(children)`, text as-is, citations as `{kind:id}`. */
function show(nodes: MdNode[]): string {
  return nodes
    .map((n) =>
      n.type === 'text'
        ? n.text
        : n.type === 'cite'
          ? `{${n.kind}:${n.id}}`
          : `${n.tag}${n.href ? `[${n.href}]` : ''}(${show(n.children)})`,
    )
    .join('');
}

describe('parseAnswer', () => {
  it('turns citation markers into cite nodes inside Markdown', () => {
    expect(
      show(parseAnswer('Price stays at **twelve dollars** [[seg:s-1]].\n\n- Launch [[block:b2]]')),
    ).toBe('p(Price stays at strong(twelve dollars) {seg:s-1}.)ul(li(Launch {block:b2}))');
  });

  it('never renders raw HTML: tags stay text', () => {
    expect(show(parseAnswer('<script>alert(1)</script> <b>hi</b>'))).toBe(
      'p(<script>alert(1)</script> <b>hi</b>)',
    );
  });

  it('keeps safe links and drops unsafe ones to text', () => {
    expect(show(parseAnswer('[ok](https://example.com/x) [bad](javascript:alert(1))'))).toBe(
      'p(a[https://example.com/x](ok) [bad](javascript:alert(1)))',
    );
    expect(show(parseAnswer('[note](/d/abc)'))).toBe('p(a[/d/abc](note))');
    expect(show(parseAnswer('[x](data:text/html,hi)'))).not.toContain('a[');
  });

  it('shows images as their alt text', () => {
    expect(show(parseAnswer('![a chart](https://evil.test/p.png)'))).toBe('p(a chart)');
  });

  it('keeps markers literal inside code and maps headings down', () => {
    expect(show(parseAnswer('# Title\n\n`[[seg:x]]`'))).toBe('h3(Title)p(code([[seg:x]]))');
  });

  it('ignores typed private-use sentinels and malformed markers', () => {
    expect(show(parseAnswer('a seg:x b [[seg: x]]'))).toBe('p(a seg:x b [[seg: x]])');
  });
});

describe('citationOrder', () => {
  it('lists each citation once, in order of first appearance', () => {
    expect(citationOrder('a [[seg:1]] b [[block:2]] c [[seg:1]]')).toEqual(['seg:1', 'block:2']);
  });

  it('skips markers shown as code', () => {
    expect(citationOrder('`[[seg:0]]` a [[seg:1]]\n\n```\n[[seg:9]]\n```')).toEqual(['seg:1']);
  });
});

describe('safeHref', () => {
  it.each([
    ['https://a.test/', 'https://a.test/'],
    ['mailto:a@b.test', 'mailto:a@b.test'],
    ['/d/1?t=3', '/d/1?t=3'],
    ['//evil.test', undefined],
    ['javascript:alert(1)', undefined],
    ['vbscript:x', undefined],
    ['', undefined],
  ])('%s → %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });
});
