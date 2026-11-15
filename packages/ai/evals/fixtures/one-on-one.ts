import raw from '../../../../fixtures/audio/one-on-one.segments.json' with { type: 'json' };
import type { EnhanceFixture } from '../../src/evals/enhance-suite.ts';
import { segments } from './helpers.ts';

/** Manager check-in; transcript is the `one-on-one` audio fixture's ground truth (mic = Alex). */
export const oneOnOne: EnhanceFixture = {
  id: 'one-on-one',
  description:
    'Short 1:1 with a release update, a follow-up owned by the manager and a schedule change.',
  meta: {
    title: 'Alex / Morgan weekly 1:1',
    startedAt: '2026-11-10T16:00:00Z',
    attendees: [
      { name: 'Alex Chen', me: true, role: 'engineer' },
      { name: 'Morgan Blake', role: "Alex's manager" },
    ],
  },
  templateId: 'one-on-one',
  myNotes: `- search rewrite shipped tues, latency -40%
- backfill old docs index tonight
- mobile sync lead?? need oncall cover`,
  transcript: segments(raw),
  expect: {
    mustMention: [
      {
        id: 'search-rewrite',
        kind: 'fact',
        description: 'The search rewrite shipped on Tuesday.',
        match: [/search rewrite/i, /tues/i],
      },
      {
        id: 'latency',
        kind: 'fact',
        description: 'Search latency dropped by about 40%.',
        match: [/latency/i, /forty percent|40\s?%/i],
      },
      {
        id: 'missing-results',
        kind: 'fact',
        description: 'A customer reported missing results for old documents.',
        match: /missing results|old documents/i,
      },
      {
        id: 'backfill',
        kind: 'action',
        description: 'Alex backfills the search index tonight.',
        match: /backfill/i,
        owner: /\bAlex\b/,
      },
      {
        id: 'support-informed',
        kind: 'fact',
        description: 'Support has already been told about the issue.',
        match: /support/i,
      },
      {
        id: 'mobile-sync',
        kind: 'decision',
        description: 'Alex was offered the lead on the mobile sync project next quarter.',
        match: /mobile sync/i,
      },
      {
        id: 'oncall-cover',
        kind: 'action',
        description: 'Morgan asks Priya about covering on-call and replies by Friday.',
        match: [/Priya/, /Friday/i],
        owner: /\bMorgan\b/,
      },
      {
        id: 'design-review',
        kind: 'action',
        description: 'Design review moved to Thursday at 2; Alex updates the invite.',
        match: [/design review/i, /Thursday/i],
        owner: /\bAlex\b/,
      },
    ],
    mustNotMention: [
      {
        id: 'wrong-percent',
        description: 'a latency improvement other than ~40%',
        match: /\b(?:[1-35-9]\d|\d)\s?%/,
      },
      {
        id: 'invented-days',
        description: 'weekdays never mentioned',
        match: /\b(?:Monday|Wednesday|Saturday|Sunday)\b/i,
      },
      {
        id: 'invented-quarter',
        description: 'a specific quarter (only "next quarter" was said)',
        match: /\bQ[1-4]\b/,
      },
    ],
    words: { min: 40, max: 350 },
  },
};
