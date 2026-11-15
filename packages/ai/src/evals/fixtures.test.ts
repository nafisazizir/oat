import { describe, expect, it } from 'vitest';
import { ENHANCE_FIXTURES } from '../../evals/index.ts';
import { EVAL_TEMPLATES } from '../../evals/templates.ts';
import { type MeetingMeta, renderMeta } from '../enhance.ts';
import { countWords } from './enhance-scorers.ts';
import { toEnhanceInput } from './enhance-suite.ts';

const test = (re: RegExp, text: string) =>
  new RegExp(re.source, re.flags.replace('g', '')).test(text);

/** The metadata as the model sees it, plus other common renderings of the meeting date/time a model might use. */
function metaText(meta: MeetingMeta): string {
  const date = new Date(meta.startedAt);
  const formats: Intl.DateTimeFormatOptions[] = [
    { dateStyle: 'full', timeStyle: 'short' },
    { dateStyle: 'medium' },
    { dateStyle: 'short' },
    { weekday: 'short', month: 'short', day: 'numeric' },
  ];
  return [
    renderMeta(meta),
    meta.startedAt.slice(0, 10),
    ...['en-US', 'en-GB'].flatMap((locale) =>
      formats.map((f) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...f }).format(date)),
    ),
  ].join('\n');
}

// Guards the fixtures themselves: an expectation the sources can't satisfy (or a "hallucination" the transcript
// actually says) would make every enhancer look wrong.
describe.each(ENHANCE_FIXTURES)('fixture $id', (fixture) => {
  const input = toEnhanceInput(fixture, EVAL_TEMPLATES);
  const transcript = input.transcript.map((s) => s.text).join('\n');
  const sources = `${fixture.myNotes}\n${transcript}`;
  const names = fixture.meta.attendees.map((a) => a.name).join('\n');

  it('has a usable transcript, notes and template', () => {
    expect(input.transcript.length).toBeGreaterThan(0);
    expect(input.myNotes.trim()).not.toBe('');
    expect(input.template.sections.length).toBeGreaterThan(0);
    for (const [a, b] of input.transcript.slice(1).map((s, i) => [input.transcript[i]!, s])) {
      expect(b!.startMs).toBeGreaterThanOrEqual(a!.startMs);
    }
    expect(fixture.meta.attendees.filter((a) => a.me)).toHaveLength(1);
    expect(fixture.expect.words.min).toBeLessThan(fixture.expect.words.max);
  });

  it('only expects mentions the sources support, with owners who are attendees or named', () => {
    for (const m of fixture.expect.mustMention) {
      for (const re of Array.isArray(m.match) ? m.match : [m.match as RegExp]) {
        expect(test(re, sources), `${m.id}: ${re}`).toBe(true);
      }
      if (m.owner) expect(test(m.owner, `${names}\n${transcript}`), `${m.id} owner`).toBe(true);
    }
  });

  it('never forbids something the sources say (notes, transcript, rendered meeting metadata)', () => {
    const grounded = `${sources}\n${metaText(fixture.meta)}`;
    for (const f of fixture.expect.mustNotMention) {
      expect(test(f.match, grounded), `${f.id}: ${f.match}`).toBe(false);
    }
  });

  it('has room for the whole transcript to be summarised within the length bounds', () => {
    expect(fixture.expect.words.max).toBeGreaterThan(Math.min(countWords(transcript), 100));
  });
});

it('has at least 5 fixtures with unique ids, including the 3 audio-backed ones', () => {
  const ids = ENHANCE_FIXTURES.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(5);
  expect(ids).toEqual(expect.arrayContaining(['one-on-one', 'standup', 'silence-gap']));
});
