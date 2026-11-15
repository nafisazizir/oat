import { describe, expect, it } from 'vitest';
import type { EnhanceInput, EnhanceOutput } from '../enhance.ts';
import {
  countWords,
  type EnhanceExpectations,
  normalize,
  noteLines,
  scoreEnhance,
} from './enhance-scorers.ts';
import type { CheckResult } from './types.ts';

const input: EnhanceInput = {
  meta: {
    title: 'Planning',
    startedAt: '2026-11-14T10:00:00Z',
    attendees: [{ name: 'Ana', me: true }, { name: 'Ben' }],
  },
  template: {
    name: 'Test',
    instructions: '',
    sections: [
      { heading: 'Summary', instructions: '' },
      { heading: 'Action items', instructions: '' },
    ],
  },
  myNotes: '# plan\n- ship v2 friday\n* [ ] ask Ben re: budget\n\n',
  transcript: [
    { source: 'mic', startMs: 0, endMs: 1000, text: 'We ship v2 on Friday.' },
    { source: 'system', startMs: 1000, endMs: 2000, text: 'I will check the budget by Monday.' },
  ],
};

const expectations: EnhanceExpectations = {
  mustMention: [
    { id: 'ship', kind: 'decision', description: 'Ship v2 Friday', match: [/v2/, /friday/i] },
    {
      id: 'budget',
      kind: 'action',
      description: 'Ben checks the budget by Monday',
      match: /budget/i,
      owner: /\bBen\b/,
    },
  ],
  mustNotMention: [{ id: 'money', description: 'amounts', match: /\$\d+/g }],
  words: { min: 5, max: 60 },
};

const good: EnhanceOutput = {
  sections: [
    {
      heading: 'Summary',
      blocks: [
        { kind: 'bullet', text: 'plan', origin: 'me' },
        { kind: 'bullet', text: 'ship v2 friday', origin: 'me' },
        { kind: 'paragraph', text: 'The team agreed to ship v2 on Friday.', origin: 'ai' },
      ],
    },
    {
      heading: 'Action items',
      blocks: [
        { kind: 'bullet', text: 'ask Ben re: budget', origin: 'me' },
        { kind: 'task', text: 'Ben: check the budget by Monday.', origin: 'ai' },
      ],
    },
  ],
};

const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c]));
const clone = (): EnhanceOutput => structuredClone(good);

describe('text helpers', () => {
  it('normalizes case, quotes and punctuation', () => {
    expect(normalize('  Ship   V2 — Friday’s plan!! ')).toBe("ship v2 friday's plan");
  });

  it('extracts note lines without list, heading or checkbox markers', () => {
    expect(noteLines(input.myNotes)).toEqual(['plan', 'ship v2 friday', 'ask Ben re: budget']);
    expect(noteLines('1. one\n2) two\n- [x] done\n   \n---')).toEqual(['one', 'two', 'done']);
  });

  it('counts words', () => {
    expect(countWords('  a b\n c ')).toBe(3);
  });
});

describe('scoreEnhance', () => {
  it('passes every check for a well-formed, complete output', () => {
    const checks = scoreEnhance(input, expectations, good);
    expect(checks.map((c) => c.id)).toEqual([
      'schema',
      'headings',
      'origin',
      'notes-coverage',
      'length',
      'mention:ship',
      'mention:budget',
      'no-hallucination:money',
    ]);
    expect(checks.every((c) => c.pass && c.score === 1)).toBe(true);
  });

  it('scores an invalid output 0 on every check, with the same ids', () => {
    for (const bad of [undefined, { sections: [] }, { sections: [{ heading: 'x' }] }]) {
      const checks = scoreEnhance(input, expectations, bad);
      expect(checks.map((c) => c.id)).toEqual(
        scoreEnhance(input, expectations, good).map((c) => c.id),
      );
      expect(checks.every((c) => c.score === 0 && !c.pass)).toBe(true);
      expect(checks[0]!.detail).toMatch(/schema invalid/);
    }
  });

  it('flags missing, extra and reordered headings', () => {
    const missing = clone();
    missing.sections[1]!.heading = 'Next steps';
    const m = byId(scoreEnhance(input, expectations, missing)).headings!;
    expect(m).toMatchObject({ score: 0.5, pass: false });
    expect(m.detail).toContain('missing: Action items');
    expect(m.detail).toContain('extra: Next steps');

    const reordered = clone();
    reordered.sections.reverse();
    const r = byId(scoreEnhance(input, expectations, reordered)).headings!;
    expect(r).toMatchObject({ score: 1, pass: false, detail: 'order differs from template' });

    const cased = clone();
    cased.sections[1]!.heading = 'action Items';
    expect(byId(scoreEnhance(input, expectations, cased)).headings!.pass).toBe(true);
  });

  it('fails origin when an AI block is labelled me, or a note line is labelled ai', () => {
    const invented = clone();
    invented.sections[0]!.blocks[2]!.origin = 'me';
    const a = byId(scoreEnhance(input, expectations, invented)).origin!;
    expect(a.pass).toBe(false);
    expect(a.score).toBeCloseTo(3 / 4);
    expect(a.detail).toContain('origin=me but not in my notes');

    const mislabelled = clone();
    mislabelled.sections[0]!.blocks[1]!.origin = 'ai';
    const b = byId(scoreEnhance(input, expectations, mislabelled)).origin!;
    expect(b.pass).toBe(false);
    expect(b.detail).toContain('my note labelled origin=ai');
  });

  it('accepts a me block that is part of a note line', () => {
    const partial = clone();
    partial.sections[0]!.blocks[1]!.text = 'Ship v2';
    const checks = byId(scoreEnhance(input, expectations, partial));
    expect(checks.origin!.pass).toBe(true);
    // …but then that note line is no longer fully kept.
    expect(checks['notes-coverage']).toMatchObject({ pass: false, score: 2 / 3 });
  });

  it('fails notes coverage when a note line is dropped', () => {
    const dropped = clone();
    dropped.sections[1]!.blocks.shift();
    const c = byId(scoreEnhance(input, expectations, dropped))['notes-coverage']!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('"ask Ben re: budget"');
  });

  it('enforces length bounds as a property (a soft, baseline-compared check)', () => {
    const short = scoreEnhance(input, { ...expectations, words: { min: 100, max: 200 } }, good);
    expect(byId(short).length).toMatchObject({ tier: 'property', pass: false, score: 0 });
    expect(byId(short).length!.detail).toMatch(/^\d+ words, expected 100–200$/);
    expect(short.filter((c) => c.tier === 'structural').every((c) => c.pass)).toBe(true);
  });

  it('scores nested children like top-level blocks and reads task owner/due fields', () => {
    const output: EnhanceOutput = {
      sections: [
        {
          heading: 'Summary',
          blocks: [
            {
              kind: 'bullet',
              text: 'plan',
              origin: 'me',
              children: [
                { kind: 'bullet', text: 'ship v2 friday', origin: 'me' },
                { kind: 'bullet', text: 'Release is $500 over.', origin: 'ai' },
                { kind: 'bullet', text: 'ask Ben re: budget', origin: 'me' },
              ],
            },
          ],
        },
        {
          heading: 'Action items',
          blocks: [
            {
              kind: 'task',
              text: 'Check the budget',
              origin: 'ai',
              owner: 'Ben',
              due: 'Monday',
            },
          ],
        },
      ],
    };
    const checks = byId(scoreEnhance(input, expectations, output));
    expect(checks['notes-coverage']!.pass).toBe(true);
    expect(checks.origin!.pass).toBe(true);
    // Patterns may match across an item and its children ("plan" › "ship v2 friday").
    expect(checks['mention:ship']!.score).toBe(1);
    // The owner can come from the task's `owner` field alone.
    const strict: EnhanceExpectations = {
      ...expectations,
      mustMention: [
        {
          id: 'check',
          kind: 'action',
          description: 'Ben checks',
          match: /check the budget/i,
          owner: /Ben/,
        },
      ],
    };
    expect(byId(scoreEnhance(input, strict, output))['mention:check']!.score).toBe(1);
    const task = output.sections[1]!.blocks[0]!;
    if (task.kind === 'task') delete task.owner;
    expect(byId(scoreEnhance(input, strict, output))['mention:check']!.score).toBe(0.5);
    // Nested AI blocks are checked for hallucinations too.
    expect(checks['no-hallucination:money']!.pass).toBe(false);
  });

  it('requires all mention patterns in the same block', () => {
    const notes = { ...input, myNotes: '- plan\n- ship v2\n- friday\n- ask Ben re: budget' };
    const apart = clone();
    apart.sections[0]!.blocks = [
      { kind: 'bullet', text: 'plan', origin: 'me' },
      { kind: 'bullet', text: 'ship v2', origin: 'me' },
      { kind: 'bullet', text: 'friday', origin: 'me' },
    ];
    expect(byId(scoreEnhance(notes, expectations, apart))['mention:ship']).toMatchObject({
      score: 0,
      pass: false,
      detail: 'missing: Ship v2 Friday',
    });
  });

  it('gives half credit to an action item whose owner is not named', () => {
    const ownerless = clone();
    ownerless.sections[1]!.blocks = [
      { kind: 'bullet', text: 'ask Ben re: budget', origin: 'me' },
      { kind: 'task', text: 'Check the budget by Monday.', origin: 'ai' },
    ];
    // "ask Ben re: budget" names Ben, so it still scores 1; drop that and only the ownerless task is left.
    expect(byId(scoreEnhance(input, expectations, ownerless))['mention:budget']!.score).toBe(1);
    ownerless.sections[1]!.blocks.shift();
    expect(byId(scoreEnhance(input, expectations, ownerless))['mention:budget']).toMatchObject({
      score: 0.5,
      pass: false,
      detail: 'owner not named',
    });
  });

  it('checks forbidden patterns in AI blocks only, and is safe with global regexes', () => {
    const notes = { ...input, myNotes: `${input.myNotes}\n- cost $500` };
    const output = clone();
    output.sections[0]!.blocks.push({ kind: 'bullet', text: 'cost $500', origin: 'me' });
    // The user's own note may mention it; scoring twice must give the same answer (no lastIndex carry-over).
    for (let i = 0; i < 2; i++) {
      expect(byId(scoreEnhance(notes, expectations, output))['no-hallucination:money']!.pass).toBe(
        true,
      );
    }
    output.sections[1]!.blocks.push({ kind: 'bullet', text: 'Budget is $900.', origin: 'ai' });
    const c = byId(scoreEnhance(notes, expectations, output))['no-hallucination:money']!;
    expect(c).toMatchObject({ score: 0, pass: false });
    expect(c.detail).toContain('Budget is $900.');
  });
});
