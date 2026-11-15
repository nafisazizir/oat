/**
 * The `enhance` eval suite: fixture meetings → `EnhanceFn` → structural/property scorers (+ judge with a real
 * model). In mock mode each fixture gets an in-process model that answers with `extractiveDraft()`, so the full
 * path (prompt → structured output → schema validation → scoring) runs offline and deterministically.
 */
import {
  type EnhanceBlock,
  type EnhanceFn,
  type EnhanceInput,
  type EnhanceOutput,
  type EnhanceSegment,
  type EnhanceTemplate,
  enhanceNotes,
  type MeetingMeta,
} from '../enhance.ts';
import { createMockModel } from '../testing.ts';
import { judgeEnhance } from './enhance-judge.ts';
import {
  countWords,
  type EnhanceExpectations,
  noteLines,
  scoreEnhance,
} from './enhance-scorers.ts';
import type { EvalSuite } from './types.ts';

export interface EnhanceFixture {
  id: string;
  /** What the fixture exercises. */
  description: string;
  meta: MeetingMeta;
  templateId: string;
  /** Rough Markdown, as typed during the meeting. */
  myNotes: string;
  transcript: readonly EnhanceSegment[];
  expect: EnhanceExpectations;
}

export const MOCK_ENHANCE_MODEL_ID = 'mock-extractive-draft';

const COMMITMENT = /\b(?:I'll|I will|I'm going to)\b/i;

/**
 * What the mock model "writes": the template's headings in order, my note lines verbatim (`origin: me`) in the
 * first section, then substantive transcript segments as `origin: ai` items spread over the sections in meeting
 * order, capped at `wordBudget`. A segment where the speaker commits ("I'll …") becomes a `task` owned by the
 * speaker (the other attendee when there is exactly one); a multi-sentence segment becomes a bullet with its
 * later sentences nested as `children`. Deterministic, schema-valid and grounded by construction — a stand-in
 * that exercises the whole output contract, not a quality bar.
 */
export function extractiveDraft(input: EnhanceInput, wordBudget = 250): EnhanceOutput {
  const sections = input.template.sections.map((s) => ({
    heading: s.heading,
    blocks: [] as EnhanceBlock[],
  }));
  if (sections.length === 0) sections.push({ heading: input.template.name, blocks: [] });
  const me = input.meta.attendees.find((a) => a.me)?.name;
  const others = input.meta.attendees.filter((a) => !a.me);
  const speaker = (s: EnhanceSegment) =>
    s.source === 'mic' ? me : others.length === 1 ? others[0]!.name : undefined;

  let words = 0;
  for (const text of noteLines(input.myNotes)) {
    sections[0]!.blocks.push({ kind: 'bullet', text, origin: 'me' });
    words += countWords(text);
  }
  const picked = input.transcript.filter((s) => countWords(s.text) >= 5);
  picked.forEach((segment, i) => {
    const text = segment.text.trim();
    const n = countWords(text);
    if (words + n > wordBudget) return;
    words += n;
    const section = sections[Math.floor((i * sections.length) / picked.length)]!;
    const owner = speaker(segment);
    if (COMMITMENT.test(text)) {
      section.blocks.push({ kind: 'task', text, origin: 'ai', ...(owner ? { owner } : {}) });
      return;
    }
    const [first, ...rest] = text.split(/(?<=[.!?])\s+/);
    section.blocks.push(
      rest.length
        ? {
            kind: 'bullet',
            text: first!,
            origin: 'ai',
            children: rest.map((t) => ({
              kind: 'bullet' as const,
              text: t,
              origin: 'ai' as const,
            })),
          }
        : { kind: 'bullet', text, origin: 'ai' },
    );
  });
  return { sections };
}

export function toEnhanceInput(
  fixture: EnhanceFixture,
  templates: Readonly<Record<string, EnhanceTemplate>>,
): EnhanceInput {
  const template = templates[fixture.templateId];
  if (!template) throw new Error(`fixture ${fixture.id}: unknown template "${fixture.templateId}"`);
  return {
    meta: fixture.meta,
    template,
    myNotes: fixture.myNotes,
    transcript: [...fixture.transcript],
  };
}

export interface CreateEnhanceSuiteOptions {
  fixtures: readonly EnhanceFixture[];
  templates: Readonly<Record<string, EnhanceTemplate>>;
  /** The enhancer under test. Default: `enhanceNotes`. */
  task?: EnhanceFn;
  /** Mock-mode model output for a fixture. Default: `extractiveDraft`. */
  mockOutput?: (input: EnhanceInput) => unknown;
}

export function createEnhanceSuite(options: CreateEnhanceSuiteOptions): EvalSuite<EnhanceFixture> {
  const { fixtures, templates, task = enhanceNotes, mockOutput = extractiveDraft } = options;
  // Resolve every template up front so a bad fixture fails loudly before anything runs.
  const inputs = new Map(fixtures.map((f) => [f.id, toEnhanceInput(f, templates)]));
  const input = (f: EnhanceFixture) => inputs.get(f.id)!;
  return {
    name: 'enhance',
    fixtures,
    role: 'enhance',
    mockModel: (f) =>
      createMockModel({
        modelId: MOCK_ENHANCE_MODEL_ID,
        responses: [JSON.stringify(mockOutput(input(f)))],
      }),
    run: (f, { model, temperature }) => task(input(f), { model, temperature }),
    score: (f, output) => scoreEnhance(input(f), f.expect, output),
    judge: (f, output, model) => judgeEnhance(input(f), f.expect, output, model),
  };
}
