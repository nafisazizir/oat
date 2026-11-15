/**
 * Quality tier (D-13): LLM-as-judge checks for enhancement, run only with `--model real`. Two questions, each a
 * structured call: are the AI-written blocks grounded in the sources, and do the notes cover the fixture's key
 * points (semantically, beyond the regex property checks)?
 */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import {
  blockContent,
  type EnhanceBlock,
  type EnhanceInput,
  enhanceOutputSchema,
  flattenBlocks,
  formatTranscript,
  renderMeta,
} from '../enhance.ts';
import type { EnhanceExpectations } from './enhance-scorers.ts';
import type { CheckResult } from './types.ts';

const groundingSchema = z.object({
  unsupported: z.array(
    z.object({
      block: z.number().int().describe('Number of the block that is not supported'),
      reason: z.string(),
    }),
  ),
});

const coverageSchema = z.object({
  covered: z.array(z.string()).describe('Ids of the key points the notes convey'),
});

/** Pass threshold for judge checks (display only; regressions are measured against the baseline). */
export const JUDGE_PASS = 0.8;

/** Output cap per judge call (verdicts are short). */
export const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** Meeting metadata (date, attendees, roles, speaker labels), the person's notes and the transcript. */
export function judgeSources(input: EnhanceInput): string {
  return [
    renderMeta(input.meta),
    `The person's own notes:\n${input.myNotes.trim() || '(none)'}`,
    `Transcript:\n${formatTranscript(input.transcript, input.meta) || '(empty)'}`,
  ].join('\n\n');
}

export async function judgeEnhance(
  input: EnhanceInput,
  expect: EnhanceExpectations,
  output: unknown,
  model: LanguageModelV4,
): Promise<CheckResult[]> {
  const parsed = enhanceOutputSchema.safeParse(output);
  if (!parsed.success) {
    return ['judge:grounding', 'judge:coverage'].map((id) => ({
      id,
      tier: 'judge' as const,
      score: 0,
      pass: false,
      detail: 'no valid output',
    }));
  }
  const blocks = flattenBlocks(parsed.data.sections.flatMap((s) => s.blocks));
  const aiBlocks = blocks.filter((b) => b.origin === 'ai');
  const results: CheckResult[] = [];

  if (aiBlocks.length === 0) {
    results.push({ id: 'judge:grounding', tier: 'judge', score: 1, pass: true });
  } else {
    const { output: verdict } = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      output: Output.object({ schema: groundingSchema }),
      system:
        'You check meeting notes for accuracy. A block is supported only if the meeting details, the notes or ' +
        'the transcript state or directly imply it. Names, numbers, dates and owners must agree with those ' +
        'sources; attributing a line to a specific attendee is fine when the attendee list and context make it ' +
        'clear. Be strict, but do not flag reasonable summarising or rewording.',
      prompt: [
        judgeSources(input),
        `Blocks to check:\n${aiBlocks.map((b, i) => `${i + 1}. ${blockContent(b)}`).join('\n')}`,
        'List every block that is not supported, with a short reason. Return an empty list if all are supported.',
      ].join('\n\n'),
    });
    const bad = new Set(
      verdict.unsupported.map((u) => u.block).filter((n) => n >= 1 && n <= aiBlocks.length),
    );
    const score = 1 - bad.size / aiBlocks.length;
    results.push({
      id: 'judge:grounding',
      tier: 'judge',
      score,
      pass: score >= JUDGE_PASS,
      ...(bad.size
        ? {
            detail: verdict.unsupported
              .filter((u) => bad.has(u.block))
              .map((u) => `#${u.block}: ${u.reason}`)
              .join('; '),
          }
        : {}),
    });
  }

  const points = expect.mustMention;
  if (points.length === 0) {
    results.push({ id: 'judge:coverage', tier: 'judge', score: 1, pass: true });
  } else {
    const notes = parsed.data.sections
      .map((s) => [`## ${s.heading}`, ...renderBlocks(s.blocks)].join('\n'))
      .join('\n\n');
    const { output: verdict } = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      output: Output.object({ schema: coverageSchema }),
      system:
        'You compare meeting notes with a list of key points. A point counts as covered when a reader of the ' +
        'notes alone would learn it, in any wording. For action items the owner must be clear.',
      prompt: [
        `Notes:\n${notes}`,
        `Key points:\n${points.map((p) => `- ${p.id}: ${p.description}`).join('\n')}`,
        'Return the ids of the covered points.',
      ].join('\n\n'),
    });
    const ids = new Set(points.map((p) => p.id));
    const covered = new Set(verdict.covered.filter((id) => ids.has(id)));
    const score = covered.size / points.length;
    const missed = points.filter((p) => !covered.has(p.id)).map((p) => p.id);
    results.push({
      id: 'judge:coverage',
      tier: 'judge',
      score,
      pass: score >= JUDGE_PASS,
      ...(missed.length ? { detail: `not covered: ${missed.join(', ')}` } : {}),
    });
  }
  return results;
}

/** Notes as indented Markdown, so the judge sees nesting and task fields. */
function renderBlocks(blocks: readonly EnhanceBlock[], depth = 0): string[] {
  const pad = '  '.repeat(depth);
  return blocks.flatMap((b) =>
    b.kind === 'paragraph'
      ? [`${pad}${b.text}`]
      : [
          `${pad}- ${b.kind === 'task' ? '[ ] ' : ''}${blockContent(b)}`,
          ...renderBlocks(b.children ?? [], depth + 1),
        ],
  );
}
