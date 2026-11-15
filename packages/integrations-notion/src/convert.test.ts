import type { JSONContent } from '@oat/editor';
import { validateChildren } from '@oat/mocks/providers/notion/validate';
import { describe, expect, it } from 'vitest';

import {
  batchBlocks,
  countBlocks,
  notionLanguage,
  notionLink,
  splitText,
  toNotionBlocks,
  toRichText,
} from './convert.ts';
import { blockData, type NotionBlock } from './types.ts';

const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const ul = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items });

/** Every request the converter's output turns into must pass the Notion mock's validator. */
function expectNotionValid(blocks: NotionBlock[]) {
  for (const batch of batchBlocks(blocks)) validateChildren(batch, 'body.children');
}

/** Plain text of each block (with type) for compact assertions. */
function outline(blocks: readonly NotionBlock[], depth = 0): string[] {
  return blocks.flatMap((b) => {
    const data = blockData(b);
    const text = (data.rich_text ?? []).map((r) => r.text.content).join('');
    return [
      `${'  '.repeat(depth)}${b.type}${text ? `: ${text}` : ''}`,
      ...outline(data.children ?? [], depth + 1),
    ];
  });
}

describe('toNotionBlocks: blocks', () => {
  it('maps every Oat block type', () => {
    const blocks = toNotionBlocks(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [t('H1')] },
        { type: 'heading', attrs: { level: 2 }, content: [t('H2')] },
        { type: 'heading', attrs: { level: 3 }, content: [t('H3')] },
        p(t('Para')),
        ul(li(p(t('Bullet')))),
        { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('One'))), li(p(t('Two')))] },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [p(t('Done'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [p(t('Todo'))] },
          ],
        },
        { type: 'blockquote', content: [p(t('Quote')), p(t('More'))] },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [t('const a = 1;\nconst b = 2;')],
        },
        { type: 'horizontalRule' },
        {
          type: 'callout',
          attrs: { emoji: '⚠️', variant: 'warning' },
          content: [p(t('Careful')), ul(li(p(t('inside'))))],
        },
        p(),
      ),
    );
    expect(outline(blocks)).toEqual([
      'heading_1: H1',
      'heading_2: H2',
      'heading_3: H3',
      'paragraph: Para',
      'bulleted_list_item: Bullet',
      'numbered_list_item: One',
      'numbered_list_item: Two',
      'to_do: Done',
      'to_do: Todo',
      'quote: Quote',
      '  paragraph: More',
      'code: const a = 1;\nconst b = 2;',
      'divider',
      'callout: Careful',
      '  bulleted_list_item: inside',
    ]);
    expect(blocks.every((b) => b.object === 'block')).toBe(true);
    expect(blockData(blocks[7]!).checked).toBe(true);
    expect(blockData(blocks[8]!).checked).toBe(false);
    expect(blockData(blocks[10]!).language).toBe('typescript');
    expect(blocks[11]).toEqual({ object: 'block', type: 'divider', divider: {} });
    expect(blockData(blocks[12]!)).toMatchObject({
      icon: { type: 'emoji', emoji: '⚠️' },
      color: 'yellow_background',
    });
    expectNotionValid(blocks);
  });

  it('maps callout variants to background colours and normalises the emoji', () => {
    const colours = (['neutral', 'info', 'success', 'warning', 'danger', 'bogus'] as const).map(
      (variant) =>
        blockData(
          toNotionBlocks(
            doc({
              type: 'callout',
              attrs: { variant, ...(variant === 'neutral' ? {} : { emoji: '🚀' }) },
              content: [p(t('x'))],
            }),
          )[0]!,
        ),
    );
    expect(colours.map((d) => d.color)).toEqual([
      'gray_background',
      'blue_background',
      'green_background',
      'yellow_background',
      'red_background',
      'gray_background',
    ]);
    expect(colours[0]!.icon).toEqual({ type: 'emoji', emoji: '💡' }); // default
    expect(colours[1]!.icon).toEqual({ type: 'emoji', emoji: '🚀' });
  });

  it('gives containers whose first child is not text an empty text and all children', () => {
    const blocks = toNotionBlocks(doc({ type: 'blockquote', content: [ul(li(p(t('a'))))] }));
    expect(outline(blocks)).toEqual(['quote', '  bulleted_list_item: a']);
    expect(blockData(blocks[0]!).rich_text).toEqual([]);
  });

  it('keeps list item paragraphs after the first as children', () => {
    const blocks = toNotionBlocks(doc(ul(li(p(t('first')), p(t('second'))))));
    expect(outline(blocks)).toEqual(['bulleted_list_item: first', '  paragraph: second']);
  });

  it('nests lists two levels deep and lifts deeper items to the deepest allowed level, in order', () => {
    const deep = ul(
      li(
        p(t('L0')),
        ul(
          li(
            p(t('L1')),
            ul(li(p(t('L2')), ul(li(p(t('L3')), ul(li(p(t('L4'))))))), li(p(t('L2b')))),
          ),
        ),
      ),
    );
    const blocks = toNotionBlocks(doc(deep));
    expect(outline(blocks)).toEqual([
      'bulleted_list_item: L0',
      '  bulleted_list_item: L1',
      '    bulleted_list_item: L2',
      '    bulleted_list_item: L3',
      '    bulleted_list_item: L4',
      '    bulleted_list_item: L2b',
    ]);
    expectNotionValid(blocks);
  });

  it('applies the nesting limit across containers (callout > list > list)', () => {
    const blocks = toNotionBlocks(
      doc({
        type: 'callout',
        attrs: { emoji: '💡', variant: 'info' },
        content: [p(t('c')), ul(li(p(t('a')), ul(li(p(t('b')), ul(li(p(t('deep'))))))))],
      }),
    );
    expect(outline(blocks)).toEqual([
      'callout: c',
      '  bulleted_list_item: a',
      '    bulleted_list_item: b',
      '    bulleted_list_item: deep',
    ]);
    expectNotionValid(blocks);
  });

  it('keeps at most 100 children per block and lifts the rest after it', () => {
    const items = Array.from({ length: 130 }, (_, i) => li(p(t(`item ${i}`))));
    const blocks = toNotionBlocks(doc(ul(li(p(t('parent')), ul(...items)))));
    expect(blockData(blocks[0]!).children).toHaveLength(100);
    expect(blocks).toHaveLength(31);
    expect(outline([blocks[1]!])).toEqual(['bulleted_list_item: item 100']);
    expectNotionValid(blocks);
  });

  it('drops trailing empty paragraphs but keeps inner ones', () => {
    expect(outline(toNotionBlocks(doc(p(t('a')), p(), p(t('b')), p(), p())))).toEqual([
      'paragraph: a',
      'paragraph',
      'paragraph: b',
    ]);
    expect(toNotionBlocks(doc())).toEqual([]);
    expect(toNotionBlocks({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
  });

  it('keeps the text of unknown blocks', () => {
    const blocks = toNotionBlocks(
      doc({ type: 'mystery', content: [t('kept')] }, { type: 'wrapper', content: [p(t('inner'))] }),
    );
    expect(outline(blocks)).toEqual(['paragraph: kept', 'paragraph: inner']);
  });
});

describe('toNotionBlocks: inline content', () => {
  it('maps marks to annotations and merges equal runs', () => {
    const rich = toRichText([
      t('bold', [{ type: 'bold' }]),
      t(' also bold', [{ type: 'bold' }]),
      t(' italic', [{ type: 'italic' }]),
      t(' struck', [{ type: 'strike' }]),
      t(' code', [{ type: 'code' }]),
      t(' marked', [{ type: 'highlight' }]),
      t(' all', [
        { type: 'bold' },
        { type: 'italic' },
        { type: 'strike' },
        { type: 'code' },
        { type: 'highlight' },
      ]),
      t(' plain'),
    ]);
    expect(rich).toEqual([
      { type: 'text', text: { content: 'bold also bold' }, annotations: { bold: true } },
      { type: 'text', text: { content: ' italic' }, annotations: { italic: true } },
      { type: 'text', text: { content: ' struck' }, annotations: { strikethrough: true } },
      { type: 'text', text: { content: ' code' }, annotations: { code: true } },
      { type: 'text', text: { content: ' marked' }, annotations: { color: 'yellow_background' } },
      {
        type: 'text',
        text: { content: ' all' },
        annotations: {
          bold: true,
          italic: true,
          strikethrough: true,
          code: true,
          color: 'yellow_background',
        },
      },
      { type: 'text', text: { content: ' plain' } },
    ]);
  });

  it('keeps absolute links, resolves relative ones against baseUrl and drops unsafe ones', () => {
    const link = (href: string) => [{ type: 'link', attrs: { href } }];
    const rich = toRichText(
      [
        t('a', link('https://example.com/x?y=1')),
        t('b', link('/d/123')),
        t('c', link('javascript:alert(1)')),
        t('d', link('mailto:a@b.c')),
      ],
      { baseUrl: 'https://oat.example' },
    );
    expect(rich.map((r) => r.text.link?.url ?? null)).toEqual([
      'https://example.com/x?y=1',
      'https://oat.example/d/123',
      null,
      'mailto:a@b.c',
    ]);
    expect(toRichText([t('b', link('/d/123'))])[0]!.text.link).toBeUndefined();
    expect(notionLink(`https://e.com/${'x'.repeat(2000)}`)).toBeNull();
  });

  it('turns mentions into plain @Name text and hard breaks into newlines', () => {
    const blocks = toNotionBlocks(
      doc(
        p(
          t('Hi ', [{ type: 'bold' }]),
          { type: 'mention', attrs: { id: 'u1', label: 'Ada Lovelace' } },
          { type: 'hardBreak' },
          t('next line'),
        ),
      ),
    );
    expect(blockData(blocks[0]!).rich_text).toEqual([
      { type: 'text', text: { content: 'Hi ' }, annotations: { bold: true } },
      { type: 'text', text: { content: '@Ada Lovelace\nnext line' } },
    ]);
  });

  it('splits text into ≤ 2000-character items without breaking surrogate pairs', () => {
    expect(splitText('abc', 2)).toEqual(['ab', 'c']);
    const emoji = `${'a'.repeat(1999)}😀b`;
    const pieces = splitText(emoji);
    expect(pieces).toEqual(['a'.repeat(1999), '😀b']);
    const long = 'x'.repeat(4500);
    const rich = toRichText([t(long, [{ type: 'italic' }])]);
    expect(rich.map((r) => r.text.content.length)).toEqual([2000, 2000, 500]);
    expect(rich.every((r) => r.annotations?.italic)).toBe(true);
    expect(rich.map((r) => r.text.content).join('')).toBe(long);
  });

  it('continues a block whose text needs more than 100 rich-text items in following paragraphs', () => {
    const text = 'y'.repeat(2000 * 150);
    const blocks = toNotionBlocks(
      doc({ type: 'heading', attrs: { level: 2 }, content: [t(text)] }, p(t('after'))),
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading_2', 'paragraph', 'paragraph']);
    expect(blockData(blocks[0]!).rich_text).toHaveLength(100);
    expect(blockData(blocks[1]!).rich_text).toHaveLength(50);
    expectNotionValid(blocks);
  });

  it('splits long code into ≤ 2000-character items and more code blocks past 100 items', () => {
    const code = 'z'.repeat(2000 * 101 + 5);
    const blocks = toNotionBlocks(
      doc({ type: 'codeBlock', attrs: { language: 'python' }, content: [t(code)] }),
    );
    expect(blocks.map((b) => b.type)).toEqual(['code', 'code']);
    expect(blockData(blocks[1]!)).toMatchObject({ language: 'python' });
    expect(blocks.flatMap((b) => blockData(b).rich_text!.map((r) => r.text.content)).join('')).toBe(
      code,
    );
    expect(toNotionBlocks(doc({ type: 'codeBlock', content: [] }))).toEqual([
      { object: 'block', type: 'code', code: { rich_text: [], language: 'plain text' } },
    ]);
  });
});

describe('code languages', () => {
  it.each([
    ['ts', 'typescript'],
    ['TypeScript', 'typescript'],
    ['js', 'javascript'],
    ['py', 'python'],
    ['sh', 'shell'],
    ['bash', 'bash'],
    ['yml', 'yaml'],
    ['cpp', 'c++'],
    ['csharp', 'c#'],
    ['dockerfile', 'docker'],
    ['', 'plain text'],
    ['brainfuck', 'plain text'],
    [undefined, 'plain text'],
  ])('%s → %s', (input, expected) => {
    expect(notionLanguage(input)).toBe(expected);
  });
});

describe('batchBlocks', () => {
  it('cuts into ≤ 100 top-level blocks per request', () => {
    const blocks = toNotionBlocks(doc(...Array.from({ length: 250 }, (_, i) => p(t(`p${i}`)))));
    const batches = batchBlocks(blocks);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(blocks);
  });

  it('counts nested blocks toward the 1000-element limit', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      li(p(t(`parent ${i}`)), ul(...Array.from({ length: 30 }, (_, j) => li(p(t(`c${j}`)))))),
    );
    const blocks = toNotionBlocks(doc(ul(...items)));
    expect(countBlocks(blocks[0]!)).toBe(31);
    const batches = batchBlocks(blocks);
    expect(batches.map((b) => b.length)).toEqual([32, 28]);
    expect(batches.every((b) => b.reduce((n, x) => n + countBlocks(x), 0) <= 1000)).toBe(true);
    expectNotionValid(blocks);
  });
});
