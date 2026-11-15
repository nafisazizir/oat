import { type JSONContent, validateDoc } from '@oat/editor';
import { toMarkdown } from '@oat/editor/markdown';
import { describe, expect, it } from 'vitest';

import type { EnhanceOutput } from './enhance.ts';
import { enhancementToDoc } from './enhance-doc.ts';
import { noteLinesFromDoc, reconcileWithNotes } from './enhance-origin.ts';

const sequentialIds = () => {
  let n = 0;
  return () => `b${++n}`;
};

const notes: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'pricing is too high', marks: [{ type: 'italic' }] }],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'send the deck' }] }],
        },
      ],
    },
  ],
};

const output: EnhanceOutput = {
  sections: [
    {
      heading: 'Summary',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Customer pushed back\non price.',
          origin: 'ai',
          sources: ['s1'],
        },
        { kind: 'paragraph', text: 'Pricing is too high', origin: 'ai' },
      ],
    },
    { heading: 'Decisions', blocks: [] },
    {
      heading: 'Action items',
      blocks: [
        { kind: 'task', text: 'send the deck', origin: 'me' },
        {
          kind: 'task',
          text: 'Share the SOC 2 report',
          origin: 'ai',
          owner: 'Riley',
          due: 'Wednesday',
          sources: ['s2', 's99', 's2'],
          children: [
            { kind: 'bullet', text: 'Security review first', origin: 'ai' },
            { kind: 'task', text: 'Ask Arjun for a slot', origin: 'ai' },
          ],
        },
        { kind: 'bullet', text: 'Pilot in two clinics', origin: 'ai' },
      ],
    },
  ],
};

describe('enhancementToDoc', () => {
  const reconciled = reconcileWithNotes(output, noteLinesFromDoc(notes));
  const { doc, citations } = enhancementToDoc(reconciled.output, {
    sourceLine: reconciled.sourceLine,
    resolveRef: (ref) => ({ s1: 'seg-a', s2: 'seg-b' })[ref],
    generateId: sequentialIds(),
  });

  it('produces a valid Oat document with an h2 per non-empty section', () => {
    expect(validateDoc(doc)).toEqual({ ok: true });
    const headings = doc.content!.filter((n) => n.type === 'heading');
    expect(headings.map((h) => [h.attrs?.level, h.attrs?.origin, h.content?.[0]?.text])).toEqual([
      [2, 'ai', 'Summary'],
      [2, 'ai', 'Action items'],
    ]);
  });

  it('reuses my inline content and checkbox for my lines, and marks every block’s origin', () => {
    const [, aiPara, mePara] = doc.content!;
    expect(aiPara).toMatchObject({
      type: 'paragraph',
      attrs: { origin: 'ai' },
      content: [{ type: 'text', text: 'Customer pushed back on price.' }],
    });
    expect(mePara).toMatchObject({
      type: 'paragraph',
      attrs: { origin: 'me' },
      content: [{ type: 'text', text: 'pricing is too high', marks: [{ type: 'italic' }] }],
    });
    const taskList = doc.content![4]!;
    expect(taskList.type).toBe('taskList');
    expect(taskList.attrs?.origin).toBe('me');
    const [mine, theirs] = taskList.content!;
    expect(mine).toMatchObject({ type: 'taskItem', attrs: { origin: 'me', checked: true } });
    expect(theirs).toMatchObject({ type: 'taskItem', attrs: { origin: 'ai', checked: false } });
    expect(theirs!.content![0]!.content![0]!.text).toBe(
      'Share the SOC 2 report — Riley, due Wednesday',
    );
    // Children grouped by kind into nested lists.
    expect(theirs!.content!.slice(1).map((n) => n.type)).toEqual(['bulletList', 'taskList']);
    // A bullet after tasks starts a new bullet list.
    expect(doc.content![5]).toMatchObject({ type: 'bulletList', attrs: { origin: 'ai' } });
  });

  it('resolves citations to segment ids per block, dropping unknown refs', () => {
    const aiParaId = doc.content![1]!.attrs!.id as string;
    const taskId = doc.content![4]!.content![1]!.attrs!.id as string;
    expect(citations).toEqual({ [aiParaId]: ['seg-a'], [taskId]: ['seg-b'] });
  });

  it('gives every block a unique id', () => {
    const ids: string[] = [];
    const visit = (n: JSONContent) => {
      if (typeof n.attrs?.id === 'string') ids.push(n.attrs.id);
      n.content?.forEach(visit);
    };
    visit(doc);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(10);
  });

  it('round-trips to Markdown with origin markers', () => {
    const md = toMarkdown(doc, { includeOrigin: true });
    expect(md).toContain('## Summary');
    expect(md).toContain('- [x] send the deck');
    expect(md).toContain('<!-- ai -->');
  });

  it('returns a minimal valid doc for empty output', () => {
    const empty = enhancementToDoc({ sections: [{ heading: 'S', blocks: [] }] });
    expect(validateDoc(empty.doc)).toEqual({ ok: true });
    expect(empty.citations).toEqual({});
  });

  it('keeps model text as plain text (no Markdown or HTML interpretation)', () => {
    const { doc: d } = enhancementToDoc({
      sections: [
        {
          heading: '<script>x</script>',
          blocks: [{ kind: 'paragraph', text: '**[click](javascript:alert(1))**', origin: 'ai' }],
        },
      ],
    });
    expect(validateDoc(d)).toEqual({ ok: true });
    expect(JSON.stringify(d)).not.toContain('"marks"');
    expect(d.content![1]!.content![0]!.text).toBe('**[click](javascript:alert(1))**');
  });
});
