/**
 * Quality tier (D-13) for the chat suite: an LLM judge scores **grounding** — is each sentence of the answer
 * supported by the sources it cites? Runs only with `--model real`. The judge sees the question, then every
 * sentence numbered with the text of its cited segments / blocks (looked up in the fixture world), and lists the
 * sentences that aren't supported. Score = share of supported sentences.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { type ChatFixture, type ChatOutput, resolveCitation, splitClaims } from './chat-scorers.ts';
import { JUDGE_MAX_OUTPUT_TOKENS, JUDGE_PASS } from './enhance-judge.ts';
import type { CheckResult } from './types.ts';

const groundingSchema = z.object({
  unsupported: z.array(
    z.object({
      sentence: z.number().int().describe('Number of the sentence that is not supported'),
      reason: z.string(),
    }),
  ),
});

const SYSTEM =
  'You audit answers that an assistant gave about the user’s own meetings and notes. Each numbered sentence is ' +
  'followed by the sources it cites. A sentence that states a fact about meetings, people, dates, numbers, ' +
  'decisions or notes is supported only if its own cited sources state or directly imply it; names, figures, ' +
  'dates and owners must agree. A factual sentence without cited sources is not supported. Sentences that only ' +
  'say the information could not be found, ask the user a question, or are clearly marked as the assistant’s ' +
  'own suggestion count as supported. Do not penalise rewording or summarising. Transcript sources start with ' +
  'the speaker; the person who recorded the meeting appears under their own name.';

/** The judge prompt for one answer (exported for tests). */
export function groundingPrompt(fixture: ChatFixture, output: ChatOutput): string {
  const claims = splitClaims(output.text);
  const lines = claims.map((claim, i) => {
    const sources = claim.citations.map((c) => {
      const source = resolveCitation(fixture.world, c);
      return source
        ? `   - [${c}] (${source.documentTitle}) ${source.text}`
        : `   - [${c}] (unknown)`;
    });
    return [
      `${i + 1}. ${claim.text}`,
      ...(sources.length ? sources : ['   - (no sources cited)']),
    ].join('\n');
  });
  return [
    `Question: ${fixture.question}`,
    `Answer, sentence by sentence:\n${lines.join('\n')}`,
    'List every sentence that is not supported by its cited sources, with a short reason. Return an empty list ' +
      'if all are supported.',
  ].join('\n\n');
}

export async function judgeChat(
  fixture: ChatFixture,
  output: unknown,
  model: LanguageModelV4,
): Promise<CheckResult[]> {
  const out = output as Partial<ChatOutput> | undefined;
  const claims = typeof out?.text === 'string' ? splitClaims(out.text) : [];
  if (claims.length === 0) {
    return [{ id: 'judge:grounding', tier: 'judge', score: 0, pass: false, detail: 'no answer' }];
  }
  const { output: verdict } = await generateText({
    model,
    temperature: 0,
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    output: Output.object({ schema: groundingSchema }),
    system: SYSTEM,
    prompt: groundingPrompt(fixture, out as ChatOutput),
  });
  const bad = new Set(
    verdict.unsupported.map((u) => u.sentence).filter((n) => n >= 1 && n <= claims.length),
  );
  const score = 1 - bad.size / claims.length;
  return [
    {
      id: 'judge:grounding',
      tier: 'judge',
      score,
      pass: score >= JUDGE_PASS,
      ...(bad.size
        ? {
            detail: verdict.unsupported
              .filter((u) => bad.has(u.sentence))
              .map((u) => `#${u.sentence}: ${u.reason}`)
              .join('; '),
          }
        : {}),
    },
  ];
}
