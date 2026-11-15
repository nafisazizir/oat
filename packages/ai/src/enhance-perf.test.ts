/**
 * SPEC §8: enhance completes in < 30 s for a 1-hour meeting. With the in-process mock model the model's own time
 * is ~0, so this measures our overhead (context build, prompt, streamed structured output parsing, origin
 * matching, TipTap conversion) on a synthetic 1-hour meeting; it must stay under 5 s.
 */
import { describe, expect, it } from 'vitest';

import { type EnhanceInput, prepareEnhance, runEnhance } from './enhance.ts';
import { enhancementToDoc } from './enhance-doc.ts';
import { extractiveDraft } from './evals/enhance-suite.ts';
import { DEFAULT_TEMPLATE } from './templates.ts';
import { createMockModel } from './testing.ts';

const TOPICS = [
  'the migration plan for the billing service',
  'hiring for the platform team next quarter',
  'customer feedback on the new onboarding flow',
  'latency regressions after the cache change',
  'the budget review with finance on Thursday',
  'security findings from the external audit',
];

/** ~150 words per minute over 60 minutes, alternating speakers, 4-second segments. */
export function oneHourMeeting(): EnhanceInput {
  const transcript: EnhanceInput['transcript'] = [];
  for (let i = 0; i < 900; i++) {
    const topic = TOPICS[Math.floor(i / 150)]!;
    transcript.push({
      id: `seg-${i}`,
      source: i % 3 === 0 ? 'mic' : 'system',
      startMs: i * 4000,
      endMs: i * 4000 + 3800,
      text: `On ${topic}, point ${i}: we looked at the numbers and agreed the next step needs an owner soon.`,
    });
  }
  const myNotes = Array.from(
    { length: 40 },
    (_, i) => `- ${TOPICS[i % TOPICS.length]} note ${i}`,
  ).join('\n');
  return {
    meta: {
      title: 'Quarterly planning',
      startedAt: '2026-11-12T10:00:00Z',
      endedAt: '2026-11-12T11:00:00Z',
      attendees: [
        { name: 'Ana', me: true, email: 'ana@acme.test' },
        { name: 'Ben', email: 'ben@acme.test' },
        { name: 'Cleo', email: 'cleo@client.test' },
      ],
    },
    template: DEFAULT_TEMPLATE,
    myNotes,
    transcript,
  };
}

describe('enhance overhead on a 1-hour meeting (mock model)', () => {
  it('runs prompt → streamed structured output → origins → TipTap in under 5 s', async () => {
    const input = oneHourMeeting();
    const draft = extractiveDraft(input, 1500);
    const model = createMockModel({ responses: [JSON.stringify(draft)] });

    const started = performance.now();
    const prepared = prepareEnhance(input);
    let previews = 0;
    const result = await runEnhance(prepared, { model, onPartial: () => previews++ });
    const { doc } = enhancementToDoc(result.output, {
      sourceLine: result.sourceLine,
      resolveRef: (ref) => prepared.context.transcript.segments.find((s) => s.ref === ref)?.id,
    });
    const elapsed = performance.now() - started;

    console.info(
      `[perf] 1-hour meeting: ${input.transcript.length} segments, ` +
        `${prepared.context.transcript.words} words, ~${prepared.context.tokens} prompt tokens, ` +
        `${JSON.stringify(draft).length} output chars → ${Math.round(elapsed)} ms`,
    );
    expect(prepared.context.transcript.truncated).toBe(false);
    expect(result.missing).toEqual([]);
    expect(JSON.stringify(doc).match(/"type":"(?:listItem|taskItem)"/g)!.length).toBeGreaterThan(
      80,
    );
    expect(previews).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  }, 20_000);
});
