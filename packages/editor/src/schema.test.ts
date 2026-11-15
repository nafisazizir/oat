import { getSchema, type JSONContent } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_TYPES,
  collectBlockIds,
  createExtensions,
  emptyDoc,
  ensureBlockIds,
  generateBlockId,
  getEditorSchema,
  normalizeCalloutEmoji,
  packageName,
  validateDoc,
} from './index.ts';

/** One of every block and mark the editor supports, as TipTap JSON (no ids yet). */
function everyBlockDoc(): JSONContent {
  const p = (text: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'paragraph',
    content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
  });
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sub' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'it', marks: [{ type: 'italic' }] },
          { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
          { type: 'text', text: 'hl', marks: [{ type: 'highlight' }] },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
          { type: 'hardBreak' },
          { type: 'mention', attrs: { id: 'u_1', label: 'Priya' } },
        ],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [p('first')] }] },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }],
      },
      { type: 'blockquote', content: [p('quoted')] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'horizontalRule' },
      {
        type: 'callout',
        attrs: { emoji: '⚠️', variant: 'warning' },
        content: [{ ...p('careful'), attrs: { origin: 'ai' } }],
      },
    ],
  };
}

describe('@oat/editor schema (headless, Node)', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@oat/editor');
  });

  it('builds the schema without a DOM', () => {
    expect(typeof document).toBe('undefined');
    const schema = getEditorSchema();
    for (const type of [...BLOCK_TYPES, 'doc', 'text', 'mention', 'hardBreak']) {
      expect(schema.nodes[type], type).toBeDefined();
    }
    for (const mark of ['bold', 'italic', 'strike', 'code', 'highlight', 'link']) {
      expect(schema.marks[mark], mark).toBeDefined();
    }
    expect(schema.marks.underline).toBeUndefined();
  });

  it('gives every block node an id and an origin attribute', () => {
    const schema = getEditorSchema();
    for (const type of BLOCK_TYPES) {
      const node = schema.nodes[type]!;
      expect(node.spec.attrs?.id, `${type}.id`).toBeDefined();
      expect(node.spec.attrs?.origin?.default, `${type}.origin`).toBe('me');
    }
    expect(schema.nodes.mention!.spec.attrs?.origin).toBeUndefined();
  });

  it('validates documents', () => {
    expect(validateDoc(everyBlockDoc())).toEqual({ ok: true });
    expect(validateDoc(emptyDoc())).toEqual({ ok: true });
    expect(validateDoc({ type: 'paragraph' })).toMatchObject({ ok: false });
    expect(validateDoc(null)).toMatchObject({ ok: false });
    const unknownNode = validateDoc({ type: 'doc', content: [{ type: 'table' }] });
    expect(unknownNode).toMatchObject({ ok: false });
    // A list item may not sit directly in the doc.
    const badNesting = validateDoc({
      type: 'doc',
      content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
    });
    expect(badNesting).toMatchObject({ ok: false });
  });

  describe('validateDoc attribute contract (server gate)', () => {
    const para = (extra: Partial<JSONContent>): JSONContent => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }], ...extra }],
    });
    const linked = (href: unknown): JSONContent => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
        },
      ],
    });
    const callout = (attrs: Record<string, unknown>): JSONContent => ({
      type: 'doc',
      content: [{ type: 'callout', attrs, content: [{ type: 'paragraph' }] }],
    });

    it.each(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', '', null])(
      'rejects link href %j',
      (href) => {
        expect(validateDoc(linked(href))).toMatchObject({
          ok: false,
          error: expect.stringContaining('link href'),
        });
      },
    );

    it.each(['https://oat.app', 'mailto:a@b.co', '/notes/1', '#top', 'tel:+15551234'])(
      'accepts link href %j',
      (href) => {
        expect(validateDoc(linked(href))).toEqual({ ok: true });
      },
    );

    it('rejects unknown origins, accepts me/ai/absent', () => {
      expect(validateDoc(para({ attrs: { origin: 'banana' } }))).toMatchObject({
        ok: false,
        error: expect.stringContaining('origin'),
      });
      expect(validateDoc(para({ attrs: { origin: 'ai' } }))).toEqual({ ok: true });
      expect(validateDoc(para({ attrs: { origin: 'me' } }))).toEqual({ ok: true });
      expect(validateDoc(para({}))).toEqual({ ok: true });
    });

    it('rejects unknown callout variants and over-long emoji', () => {
      expect(validateDoc(callout({ variant: 'rainbow' }))).toMatchObject({
        ok: false,
        error: expect.stringContaining('variant'),
      });
      expect(validateDoc(callout({ emoji: '💡 read this first' }))).toMatchObject({
        ok: false,
        error: expect.stringContaining('emoji'),
      });
      expect(validateDoc(callout({ emoji: 'x'.repeat(40) }))).toMatchObject({ ok: false });
      expect(validateDoc(callout({ emoji: '👩🏽‍💻', variant: 'danger' }))).toEqual({ ok: true });
    });
  });

  it('normalises callout emoji to one short grapheme', () => {
    expect(normalizeCalloutEmoji('⚠️')).toBe('⚠️');
    expect(normalizeCalloutEmoji('👩🏽‍💻 dev')).toBe('👩🏽‍💻');
    expect(normalizeCalloutEmoji('')).toBe('💡');
    expect(normalizeCalloutEmoji(42)).toBe('💡');
    const html = generateHTML(
      {
        type: 'doc',
        content: [
          { type: 'callout', attrs: { emoji: '🔥🔥🔥 hot' }, content: [{ type: 'paragraph' }] },
        ],
      },
      createExtensions({ placeholder: false }),
    );
    expect(html).toContain('data-emoji="🔥"');
  });

  it('generates UUIDs even without crypto.randomUUID (non-secure contexts)', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(generateBlockId()).toMatch(uuid);
    // Simulate the API being absent (http:// pages, custom protocols not registered secure).
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => generateBlockId()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(uuid);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });

  it('assigns unique ids to every block (ensureBlockIds)', () => {
    let n = 0;
    const doc = ensureBlockIds(everyBlockDoc(), () => `b${++n}`);
    const ids = collectBlockIds(doc);
    // 3 headings + 1 p + 3 lists × (list, item, p) + quote, p + code + hr + callout, p = 19
    expect(ids).toHaveLength(19);
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateDoc(doc)).toEqual({ ok: true });
  });

  it('keeps existing ids and replaces duplicates', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'keep' } },
        { type: 'paragraph', attrs: { id: 'keep' } },
        { type: 'paragraph' },
      ],
    };
    const out = ensureBlockIds(doc, () => 'fresh-' + Math.random().toString(36).slice(2));
    const ids = collectBlockIds(out);
    expect(ids[0]).toBe('keep');
    expect(new Set(ids).size).toBe(3);
    expect(doc.content![1]!.attrs!.id).toBe('keep'); // input not mutated
  });

  it('works with TipTap’s own server-side id generator', () => {
    const doc = generateUniqueIds(everyBlockDoc(), createExtensions({ placeholder: false }));
    const ids = collectBlockIds(doc);
    expect(ids).toHaveLength(19);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('round-trips origin and ids through JSON (schema parse → toJSON)', () => {
    const input = ensureBlockIds(everyBlockDoc());
    input.content![0]!.attrs = { ...input.content![0]!.attrs, origin: 'ai' };
    const node = getEditorSchema().nodeFromJSON(input);
    const output = node.toJSON() as JSONContent;
    expect(output).toEqual(getEditorSchema().nodeFromJSON(output).toJSON());
    expect(output.content![0]!.attrs).toMatchObject({
      origin: 'ai',
      id: input.content![0]!.attrs!.id,
    });
    expect(output.content![1]!.attrs).toMatchObject({ origin: 'me' });
    const callout = output.content!.find((b) => b.type === 'callout')!;
    expect(callout.attrs).toMatchObject({ emoji: '⚠️', variant: 'warning', origin: 'me' });
    expect(callout.content![0]!.attrs).toMatchObject({ origin: 'ai' });
    expect(collectBlockIds(output)).toEqual(collectBlockIds(input));
  });

  it('round-trips through HTML on the server (@tiptap/html)', () => {
    const extensions = createExtensions({ placeholder: false });
    const input = ensureBlockIds(everyBlockDoc());
    input.content![0]!.attrs = { ...input.content![0]!.attrs, origin: 'ai' };
    const html = generateHTML(input, extensions);
    expect(html).toContain('data-origin="ai"');
    expect(html).toContain('data-type="callout"');
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('<mark>');
    const back = generateJSON(html, extensions);
    expect(back).toEqual(getSchema(extensions).nodeFromJSON(input).toJSON());
  });

  it('normalises unknown origin values to "me" when parsing HTML', () => {
    const json = generateJSON(
      '<p data-origin="robot">x</p><p data-origin="ai">y</p>',
      createExtensions({ placeholder: false }),
    );
    const blocks = (json as JSONContent).content!;
    expect(blocks.map((b) => b.attrs?.origin)).toEqual(['me', 'ai']);
  });
});
