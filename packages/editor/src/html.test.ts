import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { InvalidDocumentError, renderDocumentHtml, sanitizeDocumentHtml } from './html.ts';

const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

describe('renderDocumentHtml', () => {
  it('renders every Oat block and mark with the editor schema', () => {
    const html = renderDocumentHtml(
      doc(
        { type: 'heading', attrs: { level: 2, origin: 'ai' }, content: [text('Decisions')] },
        p(
          text('bold', [{ type: 'bold' }]),
          text(' '),
          text('it', [{ type: 'italic' }]),
          text(' '),
          text('gone', [{ type: 'strike' }]),
          text(' '),
          text('x()', [{ type: 'code' }]),
          text(' '),
          text('hi', [{ type: 'highlight' }]),
          { type: 'hardBreak' },
          text('site', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1' } }]),
        ),
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [p(text('one'))] }],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [p(text('three'))] }],
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [p(text('todo'))] },
          ],
        },
        { type: 'blockquote', content: [p(text('quote'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1 < 2;')] },
        { type: 'horizontalRule' },
        { type: 'callout', attrs: { emoji: '🚀', variant: 'info' }, content: [p(text('note'))] },
      ),
    );
    expect(html).toContain('<h2 data-origin="ai">Decisions</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<s>gone</s>');
    expect(html).toContain('<code>x()</code>');
    expect(html).toContain('<mark>hi</mark>');
    expect(html).toContain('<br />');
    expect(html).toContain(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">site</a>',
    );
    expect(html).toMatch(/<ul data-origin="me"><li data-origin="me"><p data-origin="me">one/);
    expect(html).toContain('<ol data-origin="me" start="3">');
    expect(html).toContain('<li data-origin="me" data-checked="true" data-type="taskItem">');
    expect(html).toContain('<input type="checkbox" disabled="disabled" checked="checked" />');
    expect(html).toContain('<input type="checkbox" disabled="disabled" />');
    expect(html).toContain('<blockquote data-origin="me">');
    expect(html).toContain('<code class="language-ts">const a = 1 &lt; 2;</code>');
    expect(html).toContain('<hr data-origin="me" />');
    expect(html).toContain('data-type="callout"');
    expect(html).toContain('data-variant="info"');
    expect(html).toContain('🚀');
  });

  it('escapes text and attribute values', () => {
    const html = renderDocumentHtml(
      doc(
        p(text('<script>alert(1)</script> & "quotes"')),
        p(
          text('x', [
            { type: 'link', attrs: { href: 'https://e.com/"><script>alert(1)</script>' } },
          ]),
        ),
      ),
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"');
    expect(html).toContain('href="https://e.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('drops identifiers a public reader must not see: block ids and mention ids', () => {
    const html = renderDocumentHtml(
      doc({
        type: 'paragraph',
        attrs: { id: 'block-123' },
        content: [
          text('Hi '),
          { type: 'mention', attrs: { id: 'secret-user-id@example.com', label: 'Ann' } },
        ],
      }),
    );
    expect(html).not.toContain('block-123');
    expect(html).not.toContain('secret-user-id');
    expect(html).not.toContain('data-id');
    expect(html).toContain('<span class="oat-mention" data-type="mention">@Ann</span>');
  });

  it('refuses documents outside the schema or with unsafe links', () => {
    expect(() => renderDocumentHtml({ type: 'doc', content: [{ type: 'iframe' }] })).toThrow(
      InvalidDocumentError,
    );
    expect(() =>
      renderDocumentHtml(
        doc(p(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
      ),
    ).toThrow(InvalidDocumentError);
    expect(() => renderDocumentHtml({ type: 'paragraph' })).toThrow(InvalidDocumentError);
    expect(() => renderDocumentHtml(null)).toThrow(InvalidDocumentError);
  });

  it('renders an empty document as an empty paragraph', () => {
    expect(renderDocumentHtml(doc(p()))).toBe('<p data-origin="me"></p>');
  });
});

describe('sanitizeDocumentHtml (allowlist)', () => {
  it.each([
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<img src=x onerror=alert(1)>', ''],
    ['<p onclick="alert(1)" style="color:red" data-origin="ai">x</p>', '<p data-origin="ai">x</p>'],
    [
      '<a href="javascript:alert(1)">x</a>',
      '<a target="_blank" rel="noopener noreferrer nofollow">x</a>',
    ],
    [
      '<a href="//evil.example/x">x</a>',
      '<a target="_blank" rel="noopener noreferrer nofollow">x</a>',
    ],
    [
      '<a href="https://ok.example" target="_self" rel="opener">x</a>',
      '<a href="https://ok.example" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    ],
    ['<iframe src="https://e.com"></iframe><object data="x"></object>', ''],
    ['<svg><script>alert(1)</script></svg>', ''],
    ['<style>body{display:none}</style>', ''],
    ['<form action="https://e.com"><input type="text" name="q"></form>', '<span></span>'],
    [
      '<span class="oat-mention evil" data-id="u1">@A</span>',
      '<span class="oat-mention">@A</span>',
    ],
    ['<code class="language-js bad">x</code>', '<code class="language-js">x</code>'],
    ['<div data-type="callout" id="x" data-foo="y">c</div>', '<div data-type="callout">c</div>'],
  ])('%s', (input, expected) => {
    expect(sanitizeDocumentHtml(input)).toBe(expected);
  });
});
