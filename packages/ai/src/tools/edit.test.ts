import { describe, expect, it } from 'vitest';
import { applyTextEdits } from './edit.ts';

const bold = [{ type: 'bold' }];
const doc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'p1', origin: 'ai' },
      content: [
        { type: 'text', text: 'Ship the ' },
        { type: 'text', text: 'billing export', marks: bold },
        { type: 'text', text: ' on Friday with ' },
        { type: 'mention', attrs: { id: 'u1', label: 'Ana' } },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'bulletList',
      attrs: { id: 'l1' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'li1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p2' },
              content: [{ type: 'text', text: 'Budget review' }],
            },
          ],
        },
      ],
    },
    { type: 'codeBlock', attrs: { id: 'c1' }, content: [{ type: 'text', text: 'let x = 1;' }] },
  ],
};

describe('applyTextEdits', () => {
  it('changes only the touched text, keeping marks, ids and origin', () => {
    const result = applyTextEdits(doc, [{ find: 'Friday', replace: 'Monday' }]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const p1 = (result.doc as typeof doc).content[0]!;
    expect(p1.attrs).toEqual({ id: 'p1', origin: 'ai' });
    expect(p1.content).toEqual([
      { type: 'text', text: 'Ship the ' },
      { type: 'text', text: 'billing export', marks: bold },
      { type: 'text', text: ' on ' },
      { type: 'text', text: 'Monday' },
      { type: 'text', text: ' with ' },
      { type: 'mention', attrs: { id: 'u1', label: 'Ana' } },
      { type: 'text', text: '.' },
    ]);
    expect(result.changes).toEqual([
      {
        blockId: 'p1',
        before: 'Ship the billing export on Friday with @Ana.',
        after: 'Ship the billing export on Monday with @Ana.',
      },
    ]);
    // The rest of the document is untouched, and the input isn't mutated.
    expect((result.doc as typeof doc).content.slice(1)).toEqual(doc.content.slice(1));
    expect(doc.content[0]!.content[2]).toEqual({ type: 'text', text: ' on Friday with ' });
  });

  it('a match across marks takes the marks where it starts; text never matches through a mention', () => {
    expect(applyTextEdits(doc, [{ find: 'with Ana', replace: 'x' }]).ok).toBe(false);
    const across = applyTextEdits(doc, [{ find: 'export on', replace: 'report by' }]);
    if (!across.ok) throw new Error('expected ok');
    expect((across.doc as typeof doc).content[0]!.content.slice(0, 3)).toEqual([
      { type: 'text', text: 'Ship the ' },
      { type: 'text', text: 'billing ', marks: bold },
      { type: 'text', text: 'report by', marks: bold },
    ]);
  });

  it('applies several edits in order, nested blocks included', () => {
    const result = applyTextEdits(doc, [
      { find: 'Budget review', replace: 'Budget review moved' },
      { find: 'review moved', replace: 'review cancelled' },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.changes).toEqual([
      { blockId: 'p2', before: 'Budget review', after: 'Budget review cancelled' },
    ]);
  });

  it('removing all text leaves an empty block', () => {
    const result = applyTextEdits(doc, [{ find: 'Budget review', replace: '' }]);
    if (!result.ok) throw new Error('expected ok');
    const list = (result.doc as { content: { content: { content: unknown[] }[] }[] }).content[1]!;
    const p2 = list.content[0]!.content[0];
    expect(p2).toEqual({ type: 'paragraph', attrs: { id: 'p2' } });
  });

  it('reports missing, ambiguous and invalid edits', () => {
    expect(applyTextEdits(doc, [{ find: 'Tuesday', replace: 'x' }])).toEqual({
      ok: false,
      error: { code: 'not_found', editIndex: 0 },
    });
    expect(applyTextEdits(doc, [{ find: 'e', replace: 'x' }])).toMatchObject({
      ok: false,
      error: { code: 'ambiguous', editIndex: 0 },
    });
    expect(applyTextEdits(doc, [{ find: 'Friday', replace: 'a\nb' }])).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
    expect(applyTextEdits(doc, [{ find: 'x = 1', replace: 'x = 1\ny = 2' }]).ok).toBe(true);
    expect(applyTextEdits({ type: 'paragraph' }, [{ find: 'a', replace: 'b' }]).ok).toBe(false);
    expect(applyTextEdits(doc, []).ok).toBe(false);
  });
});
