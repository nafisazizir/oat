/**
 * Review 4.4 findings 2 and 5: re-enhancing an enhanced body, and note lines typed more than once.
 */
import { type JSONContent, validateDoc } from '@oat/editor';
import { describe, expect, it } from 'vitest';

import { type EnhanceInput, type EnhanceOutput, prepareEnhance, runEnhance } from './enhance.ts';
import { enhancementToDoc } from './enhance-doc.ts';
import {
  myNotesOnly,
  noteLinesFromDoc,
  notesDocFromMarkdown,
  OTHER_NOTES_HEADING,
  reconcileWithNotes,
} from './enhance-origin.ts';
import { createMockModel } from './testing.ts';

const input: EnhanceInput = {
  meta: {
    title: 'Sync',
    startedAt: '2026-11-12T10:00:00Z',
    attendees: [{ name: 'Ana', me: true }],
  },
  template: {
    name: 'T',
    instructions: '',
    sections: [
      { heading: 'Summary', instructions: '' },
      { heading: 'Action items', instructions: '' },
    ],
  },
  myNotes: '',
  transcript: [{ source: 'mic', startMs: 0, endMs: 1, text: 'We agreed to ship on Friday.' }],
};

/** The model keeps "ship friday", adds its own lines, and drops "book the room". */
const answer: EnhanceOutput = {
  sections: [
    {
      heading: 'Summary',
      blocks: [
        { kind: 'paragraph', text: 'The team agreed on the release date.', origin: 'ai' },
        {
          kind: 'bullet',
          text: 'ship friday',
          origin: 'me',
          children: [{ kind: 'bullet', text: 'Ben confirmed the designs.', origin: 'ai' }],
        },
      ],
    },
    {
      heading: 'Action items',
      blocks: [{ kind: 'task', text: 'Send release notes', origin: 'ai', owner: 'Ana' }],
    },
  ],
};

async function enhance(notesDoc: JSONContent, output: EnhanceOutput) {
  const model = createMockModel({ responses: [JSON.stringify(output)] });
  const prepared = prepareEnhance({ ...input, notesDoc });
  const result = await runEnhance(prepared, { model });
  return { prepared, result, doc: enhancementToDoc(result.output, result).doc };
}

const texts = (node: JSONContent): string[] =>
  node.type === 'text' ? [node.text ?? ''] : (node.content ?? []).flatMap(texts);

describe('re-enhancing an enhanced note', () => {
  it('reads only my lines as notes, keeps origins, and adds no second "Other notes"', async () => {
    const notes = notesDocFromMarkdown('- ship friday\n- [ ] book the room');
    const first = await enhance(notes, answer);
    expect(validateDoc(first.doc)).toEqual({ ok: true });
    expect(first.result.missing.map((l) => l.text)).toEqual(['book the room']);

    // The enhanced body: AI headings/lines must not count as my notes.
    const mine = noteLinesFromDoc(first.doc);
    expect(mine.map((l) => [l.kind, l.text])).toEqual([
      ['bullet', 'ship friday'],
      ['task', 'book the room'],
    ]);
    const myDoc = myNotesOnly(first.doc)!;
    expect(validateDoc(myDoc)).toEqual({ ok: true });
    expect(texts(myDoc)).toEqual(['ship friday', 'book the room']);

    // Enhance the enhanced body again with the same answer.
    const second = await enhance(first.doc, answer);
    expect(second.prepared.notesDoc).toEqual(myDoc);
    expect(second.prepared.prompt).not.toContain('The team agreed on the release date.');
    const all = texts(second.doc);
    expect(all.filter((t) => t === OTHER_NOTES_HEADING)).toHaveLength(1);
    expect(all.filter((t) => t === 'Summary')).toHaveLength(1);
    expect(all.filter((t) => t === 'ship friday')).toHaveLength(1);
    expect(all.filter((t) => t === 'book the room')).toHaveLength(1);
    // Origins: exactly my two lines are `me` textblocks.
    const meTexts: string[] = [];
    const visit = (n: JSONContent) => {
      if (n.type === 'paragraph' && n.attrs?.origin === 'me') meTexts.push(texts(n).join(''));
      n.content?.forEach(visit);
    };
    visit(second.doc);
    expect(meTexts).toEqual(['ship friday', 'book the room']);
  });

  it('counts a line I typed into an enhanced note as mine, and an AI line I edited as AI', () => {
    const body: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, origin: 'ai' },
          content: [{ type: 'text', text: 'Summary' }],
        },
        {
          type: 'bulletList',
          attrs: { origin: 'ai' },
          content: [
            {
              type: 'listItem',
              attrs: { origin: 'ai' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { origin: 'ai' },
                  content: [{ type: 'text', text: 'AI line, edited' }],
                },
              ],
            },
            {
              type: 'listItem',
              attrs: { origin: 'me' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { origin: 'me' },
                  content: [{ type: 'text', text: 'my new bullet' }],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          attrs: { origin: 'me' },
          content: [{ type: 'text', text: 'typed after' }],
        },
      ],
    };
    expect(noteLinesFromDoc(body).map((l) => l.text)).toEqual(['my new bullet', 'typed after']);
    // A body with no AI blocks is passed through untouched (structure kept).
    const plain = notesDocFromMarkdown('# Agenda\n- a\n  - b');
    expect(myNotesOnly(plain)).toBe(plain);
    expect(myNotesOnly({ type: 'doc', content: [body.content![0]!] })).toBeNull();
  });
});

describe('note lines typed more than once', () => {
  it('matches each copy once (multiset), so a line kept twice is not re-added', () => {
    const lines = noteLinesFromDoc(notesDocFromMarkdown('- follow up\n- budget\n- follow up'));
    const { output, missing } = reconcileWithNotes(
      {
        sections: [
          {
            heading: 'S',
            blocks: [
              { kind: 'bullet', text: 'follow up', origin: 'ai' },
              { kind: 'bullet', text: 'Follow up!', origin: 'ai' },
            ],
          },
        ],
      },
      lines,
    );
    expect(missing.map((l) => [l.index, l.text])).toEqual([[1, 'budget']]);
    expect(output.sections.at(-1)!.blocks.map((b) => b.text)).toEqual(['budget']);
    expect(output.sections[0]!.blocks.every((b) => b.origin === 'me')).toBe(true);
  });

  it('still marks a third copy `me` (never labels my words as AI), without re-adding anything', () => {
    const lines = noteLinesFromDoc(notesDocFromMarkdown('- follow up'));
    const { output, missing } = reconcileWithNotes(
      {
        sections: [
          {
            heading: 'S',
            blocks: [
              { kind: 'bullet', text: 'follow up', origin: 'ai' },
              { kind: 'bullet', text: 'follow up', origin: 'ai' },
            ],
          },
        ],
      },
      lines,
    );
    expect(missing).toEqual([]);
    expect(output.sections).toHaveLength(1);
    expect(output.sections[0]!.blocks.map((b) => b.origin)).toEqual(['me', 'me']);
  });
});

describe('code blocks in my notes', () => {
  it('come back under "Other notes" as code blocks with their line breaks', () => {
    const notes = notesDocFromMarkdown('```\nSELECT 1;\nSELECT 2;\n```');
    const reconciled = reconcileWithNotes(
      { sections: [{ heading: 'S', blocks: [] }] },
      noteLinesFromDoc(notes),
    );
    const { doc } = enhancementToDoc(reconciled.output, { sourceLine: reconciled.sourceLine });
    expect(validateDoc(doc)).toEqual({ ok: true });
    expect(doc.content!.at(-1)).toMatchObject({
      type: 'codeBlock',
      attrs: { origin: 'me' },
      content: [{ type: 'text', text: 'SELECT 1;\nSELECT 2;' }],
    });
  });
});
