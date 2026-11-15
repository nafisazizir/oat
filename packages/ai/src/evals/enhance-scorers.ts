/**
 * Deterministic scorers for enhancement output (structural + property tiers). Expectations are properties,
 * never golden text: facts/decisions/action items that must appear (regex), names/numbers that must not, the
 * user's notes kept with `origin: me`, the template's headings, and length bounds.
 */
import { blockContent, type EnhanceInput, enhanceOutputSchema, flattenBlocks } from '../enhance.ts';
import { OTHER_NOTES_HEADING } from '../enhance-origin.ts';
import type { CheckResult } from './types.ts';

export interface MentionExpectation {
  id: string;
  kind: 'fact' | 'decision' | 'action';
  /** Plain-language statement of the point (also the judge's reference list). */
  description: string;
  /** Every pattern must match the same block. */
  match: RegExp | readonly RegExp[];
  /** Action items: the matching block must also name the owner (half credit without). */
  owner?: RegExp;
}

export interface ForbiddenExpectation {
  id: string;
  description: string;
  /** Must not match any `origin: ai` block (the user's own notes may say anything). */
  match: RegExp;
}

export interface EnhanceExpectations {
  mustMention: readonly MentionExpectation[];
  mustNotMention: readonly ForbiddenExpectation[];
  /** Whole-output word count bounds (headings excluded). */
  words: { min: number; max: number };
}

/** Lowercase, straight quotes, punctuation → spaces, collapsed whitespace. For containment checks. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}%$']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The user's note lines with Markdown list/heading/checkbox markers stripped; blank lines dropped. */
export function noteLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .trim(),
    )
    .filter((line) => normalize(line).length > 0);
}

/** A fresh, non-global copy, so `test()` never carries `lastIndex` between calls. */
const fresh = (re: RegExp) => new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
const matches = (re: RegExp, text: string) => fresh(re).test(text);

const check = (
  id: string,
  tier: CheckResult['tier'],
  score: number,
  pass: boolean,
  detail?: string,
): CheckResult => (detail ? { id, tier, score, pass, detail } : { id, tier, score, pass });

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

/** Every check id this fixture produces, scored 0 — used when the output is unusable. */
export function failedEnhanceChecks(expect: EnhanceExpectations, reason: string): CheckResult[] {
  return [
    check('schema', 'structural', 0, false, reason),
    ...['headings', 'origin', 'notes-coverage'].map((id) =>
      check(id, 'structural', 0, false, 'no valid output'),
    ),
    check('length', 'property', 0, false, 'no valid output'),
    ...expect.mustMention.map((m) =>
      check(`mention:${m.id}`, 'property', 0, false, 'no valid output'),
    ),
    ...expect.mustNotMention.map((f) =>
      check(`no-hallucination:${f.id}`, 'property', 0, false, 'no valid output'),
    ),
  ];
}

export function scoreEnhance(
  input: EnhanceInput,
  expect: EnhanceExpectations,
  output: unknown,
): CheckResult[] {
  const parsed = enhanceOutputSchema.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failedEnhanceChecks(
      expect,
      `schema invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`,
    );
  }
  const { sections } = parsed.data;
  // Nested list items count like top-level blocks.
  const blocks = flattenBlocks(sections.flatMap((s) => s.blocks));
  const results: CheckResult[] = [check('schema', 'structural', 1, true)];

  // Headings: exactly the template's, in order. A trailing "Other notes" section (note lines the model dropped,
  // put back by `reconcileWithNotes`) is part of the contract, not an extra heading.
  const wanted = input.template.sections.map((s) => normalize(s.heading));
  const otherNotes = normalize(OTHER_NOTES_HEADING);
  const scored = sections.filter(
    (s, i) =>
      !(
        i === sections.length - 1 &&
        normalize(s.heading) === otherNotes &&
        !wanted.includes(otherNotes)
      ),
  );
  const got = scored.map((s) => normalize(s.heading));
  const present = wanted.filter((h) => got.includes(h)).length;
  const exact = wanted.length === got.length && wanted.every((h, i) => got[i] === h);
  const missing = input.template.sections.filter((s) => !got.includes(normalize(s.heading)));
  const extra = scored.filter((s) => !wanted.includes(normalize(s.heading)));
  results.push(
    check(
      'headings',
      'structural',
      ratio(present, wanted.length),
      exact,
      exact
        ? undefined
        : [
            missing.length ? `missing: ${missing.map((s) => s.heading).join(', ')}` : '',
            extra.length ? `extra: ${extra.map((s) => s.heading).join(', ')}` : '',
            !missing.length && !extra.length ? 'order differs from template' : '',
          ]
            .filter(Boolean)
            .join('; '),
    ),
  );

  // Origin: `me` blocks must come from my notes; a verbatim note line must not be labelled `ai`.
  const lines = noteLines(input.myNotes).map(normalize);
  const notesText = lines.join(' \n ');
  const meBlocks = blocks.filter((b) => b.origin === 'me');
  const unfaithful = meBlocks.filter((b) => !notesText.includes(normalize(b.text)));
  const mislabelled = blocks.filter((b) => b.origin === 'ai' && lines.includes(normalize(b.text)));
  const originTotal = meBlocks.length + mislabelled.length;
  const originBad = unfaithful.length + mislabelled.length;
  results.push(
    check(
      'origin',
      'structural',
      ratio(originTotal - originBad, originTotal),
      originBad === 0,
      originBad
        ? [
            unfaithful.length
              ? `origin=me but not in my notes: ${unfaithful.map((b) => `"${b.text}"`).join(', ')}`
              : '',
            mislabelled.length
              ? `my note labelled origin=ai: ${mislabelled.map((b) => `"${b.text}"`).join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('; ')
        : undefined,
    ),
  );

  // Notes coverage: every note line kept in some `me` block.
  const meTexts = meBlocks.map((b) => normalize(b.text));
  const dropped = noteLines(input.myNotes).filter(
    (_, i) => !meTexts.some((t) => t.includes(lines[i]!)),
  );
  results.push(
    check(
      'notes-coverage',
      'structural',
      ratio(lines.length - dropped.length, lines.length),
      dropped.length === 0,
      dropped.length
        ? `not kept as origin=me: ${dropped.map((l) => `"${l}"`).join(', ')}`
        : undefined,
    ),
  );

  // Length bounds (property: a real model running long is a quality signal, not a broken contract).
  const words = blocks.reduce((n, b) => n + countWords(b.text), 0);
  const inBounds = words >= expect.words.min && words <= expect.words.max;
  results.push(
    check(
      'length',
      'property',
      inBounds ? 1 : 0,
      inBounds,
      inBounds ? undefined : `${words} words, expected ${expect.words.min}–${expect.words.max}`,
    ),
  );

  // Must mention: all patterns within one item (a block plus its nested children); action owners in that same
  // item (text or the task's `owner` field).
  const items = blocks.map((b) => flattenBlocks([b]).map(blockContent).join('\n'));
  for (const m of expect.mustMention) {
    const patterns: readonly RegExp[] = Array.isArray(m.match) ? m.match : [m.match as RegExp];
    const hits = items.filter((t) => patterns.every((re) => matches(re, t)));
    const owned = m.owner ? hits.some((t) => matches(m.owner!, t)) : hits.length > 0;
    const score = hits.length === 0 ? 0 : owned ? 1 : 0.5;
    results.push(
      check(
        `mention:${m.id}`,
        'property',
        score,
        score === 1,
        score === 1 ? undefined : score === 0 ? `missing: ${m.description}` : 'owner not named',
      ),
    );
  }

  // Must not mention (AI-written blocks only).
  const aiBlocks = blocks.filter((b) => b.origin === 'ai');
  for (const f of expect.mustNotMention) {
    const offending = aiBlocks.find((b) => matches(f.match, blockContent(b)));
    results.push(
      check(
        `no-hallucination:${f.id}`,
        'property',
        offending ? 0 : 1,
        !offending,
        offending ? `${f.description}: "${blockContent(offending)}"` : undefined,
      ),
    );
  }

  return results;
}
