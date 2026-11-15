import { describe, expect, it } from 'vitest';
import { type EnhanceInput, type EnhanceOutput, renderMeta } from '../enhance.ts';
import { createMockModel, promptText } from '../testing.ts';
import { JUDGE_MAX_OUTPUT_TOKENS, judgeEnhance } from './enhance-judge.ts';
import type { EnhanceExpectations } from './enhance-scorers.ts';

const input: EnhanceInput = {
  meta: { title: 'T', startedAt: '2026-11-14T10:00:00Z', attendees: [{ name: 'Ana', me: true }] },
  template: { name: 'T', instructions: '', sections: [{ heading: 'Notes', instructions: '' }] },
  myNotes: '- launch friday',
  transcript: [{ source: 'mic', startMs: 0, endMs: 1000, text: 'We launch on Friday.' }],
};

const expectations: EnhanceExpectations = {
  mustMention: [
    { id: 'launch', kind: 'decision', description: 'Launch on Friday', match: /launch/i },
    { id: 'owner', kind: 'action', description: 'Ana owns the launch', match: /Ana/ },
  ],
  mustNotMention: [],
  words: { min: 1, max: 100 },
};

const output: EnhanceOutput = {
  sections: [
    {
      heading: 'Notes',
      blocks: [
        { kind: 'bullet', text: 'launch friday', origin: 'me' },
        { kind: 'bullet', text: 'Launch is on Friday.', origin: 'ai' },
        { kind: 'bullet', text: 'Revenue grew 20%.', origin: 'ai' },
      ],
    },
  ],
};

describe('judgeEnhance', () => {
  it('scores grounding and coverage from the judge’s structured verdicts', async () => {
    const judge = createMockModel({
      handler: (call) =>
        promptText(call).includes('Key points')
          ? JSON.stringify({ covered: ['launch', 'not-a-point'] })
          : JSON.stringify({
              unsupported: [
                { block: 2, reason: 'no revenue figure in the sources' },
                { block: 99, reason: 'out of range, ignored' },
              ],
            }),
    });
    const checks = await judgeEnhance(input, expectations, output, judge);
    expect(checks).toEqual([
      {
        id: 'judge:grounding',
        tier: 'judge',
        score: 0.5,
        pass: false,
        detail: '#2: no revenue figure in the sources',
      },
      {
        id: 'judge:coverage',
        tier: 'judge',
        score: 0.5,
        pass: false,
        detail: 'not covered: owner',
      },
    ]);
    // Only AI-written blocks are sent for grounding; the key points are listed by id.
    const [grounding, coverage] = judge.doGenerateCalls.map(promptText);
    expect(grounding).toContain('1. Launch is on Friday.\n2. Revenue grew 20%.');
    expect(grounding).not.toContain('1. launch friday');
    expect(coverage).toContain('- owner: Ana owns the launch');
    // Grounding sees who is who (date, attendees, roles, what "Others" means) next to notes and transcript.
    expect(grounding).toContain(renderMeta(input.meta));
    expect(grounding).toContain('"Others" is everyone else on the call');
    expect(grounding).toContain('[00:00] Ana: We launch on Friday.');
    for (const call of judge.doGenerateCalls) {
      expect(call).toMatchObject({ temperature: 0, maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS });
    }
  });

  it('shows the coverage judge nesting and task owner/due', async () => {
    const judge = createMockModel({ responses: [JSON.stringify({ covered: [] })] });
    const meOnly: EnhanceOutput = {
      sections: [
        {
          heading: 'Notes',
          blocks: [
            {
              kind: 'bullet',
              text: 'launch friday',
              origin: 'me',
              children: [
                { kind: 'task', text: 'launch', origin: 'me', owner: 'Ana', due: 'Friday' },
              ],
            },
          ],
        },
      ],
    };
    await judgeEnhance(input, expectations, meOnly, judge);
    expect(promptText(judge.doGenerateCalls[0]!)).toContain(
      '## Notes\n- launch friday\n  - [ ] launch · Owner: Ana · Due: Friday',
    );
  });

  it('scores invalid output 0 without calling the judge', async () => {
    const judge = createMockModel({ responses: ['{}'] });
    const checks = await judgeEnhance(input, expectations, { sections: 'nope' }, judge);
    expect(checks.map((c) => [c.id, c.score])).toEqual([
      ['judge:grounding', 0],
      ['judge:coverage', 0],
    ]);
    expect(judge.doGenerateCalls).toHaveLength(0);
  });

  it('skips the grounding call when there are no AI blocks', async () => {
    const judge = createMockModel({
      responses: [JSON.stringify({ covered: ['launch', 'owner'] })],
    });
    const meOnly: EnhanceOutput = {
      sections: [
        { heading: 'Notes', blocks: [{ kind: 'bullet', text: 'launch friday', origin: 'me' }] },
      ],
    };
    const checks = await judgeEnhance(input, expectations, meOnly, judge);
    expect(checks.map((c) => [c.id, c.score, c.pass])).toEqual([
      ['judge:grounding', 1, true],
      ['judge:coverage', 1, true],
    ]);
    expect(judge.doGenerateCalls).toHaveLength(1);
  });
});
