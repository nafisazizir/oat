import { describe, expect, it } from 'vitest';
import { CHAT_FIXTURES } from '../../evals/chat/fixtures.ts';
import { createMockModel, promptText } from '../testing.ts';
import { groundingPrompt, judgeChat } from './chat-judge.ts';
import type { ChatOutput } from './chat-scorers.ts';
import { JUDGE_MAX_OUTPUT_TOKENS } from './enhance-judge.ts';

const fixture = CHAT_FIXTURES.find((f) => f.id === 'starter-price')!;

const output: ChatOutput = {
  text:
    'The starter plan stays at nine euros per seat [[seg:pr-2]]. ' +
    'Annual billing gets a discount [[block:pr-b2]]. Jonas will update the website.',
  citations: ['seg:pr-2', 'block:pr-b2'],
  dropped: [],
  provided: ['seg:pr-2', 'block:pr-b2'],
  toolCalls: ['searchMeetings'],
  toolOutputs: [],
};

describe('judgeChat', () => {
  it('shows the judge each sentence with the text of its own cited sources', () => {
    const prompt = groundingPrompt(fixture, output);
    expect(prompt).toContain(`Question: ${fixture.question}`);
    expect(prompt).toContain(
      '1. The starter plan stays at nine euros per seat.\n' +
        '   - [seg:pr-2] (Pricing review with Jonas) Jonas: I agree, the starter plan price stays at nine euros per seat until spring.',
    );
    expect(prompt).toContain(
      '2. Annual billing gets a discount.\n' +
        '   - [block:pr-b2] (Pricing review with Jonas) Annual billing gets a fifteen percent discount.',
    );
    expect(prompt).toContain('3. Jonas will update the website.\n   - (no sources cited)');
  });

  it('scores the share of supported sentences, ignoring out-of-range verdicts', async () => {
    const judge = createMockModel({
      handler: () =>
        JSON.stringify({
          unsupported: [
            { sentence: 3, reason: 'no source; Mira said she would update the page' },
            { sentence: 9, reason: 'out of range' },
          ],
        }),
    });
    const [check] = await judgeChat(fixture, output, judge);
    expect(check).toMatchObject({
      id: 'judge:grounding',
      tier: 'judge',
      pass: false,
      detail: '#3: no source; Mira said she would update the page',
    });
    expect(check!.score).toBeCloseTo(2 / 3);
    expect(judge.doGenerateCalls).toHaveLength(1);
    expect(judge.doGenerateCalls[0]).toMatchObject({
      temperature: 0,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    expect(promptText(judge.doGenerateCalls[0]!)).toContain('3. Jonas will update the website.');
  });

  it('passes a fully supported answer and scores an empty one 0 without calling the judge', async () => {
    const judge = createMockModel({ responses: [JSON.stringify({ unsupported: [] })] });
    expect(await judgeChat(fixture, output, judge)).toEqual([
      { id: 'judge:grounding', tier: 'judge', score: 1, pass: true },
    ]);
    const idle = createMockModel({ responses: ['{}'] });
    expect(await judgeChat(fixture, { ...output, text: '' }, idle)).toEqual([
      { id: 'judge:grounding', tier: 'judge', score: 0, pass: false, detail: 'no answer' },
    ]);
    expect(await judgeChat(fixture, undefined, idle)).toHaveLength(1);
    expect(idle.doGenerateCalls).toHaveLength(0);
  });
});
