import raw from '../../../../fixtures/audio/silence-gap.segments.json' with { type: 'json' };
import type { EnhanceFixture } from '../../src/evals/enhance-suite.ts';
import { segments } from './helpers.ts';

/**
 * Near-empty meeting (the `silence-gap` audio fixture's ground truth): connection trouble, then "let's go through
 * the numbers" — but no numbers are ever said. Tests that the enhancer stays short and invents nothing.
 */
export const silenceGap: EnhanceFixture = {
  id: 'silence-gap',
  description: 'Very little content; the notes must stay short and must not invent the numbers.',
  meta: {
    title: 'Dashboard walkthrough',
    startedAt: '2026-11-12T14:00:00Z',
    attendees: [
      { name: 'Alex Chen', me: true },
      { name: 'Robin Patel', role: 'presenting the dashboard' },
    ],
  },
  templateId: 'general',
  myNotes: 'dashboard review',
  transcript: segments(raw),
  expect: {
    mustMention: [
      {
        id: 'dashboard',
        kind: 'fact',
        description: 'The dashboard was shared on screen and reviewed.',
        match: /dashboard/i,
      },
      {
        id: 'audio-trouble',
        kind: 'fact',
        description: 'Alex had connection / mute trouble at the start.',
        match: /mute|connection/i,
      },
    ],
    mustNotMention: [
      {
        id: 'invented-figures',
        description: 'figures (none were said)',
        // Amounts, percentages and counts — not the date/time from the meeting metadata.
        match:
          /\d\s?%|\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:k|M|million|thousand|users|customers|visits|sessions|orders)\b/,
      },
      {
        id: 'invented-metrics',
        description: 'metrics never named',
        match: /\b(?:revenue|growth|churn|conversion|signups?)\b/i,
      },
      {
        id: 'invented-actions',
        description: 'follow-ups nobody agreed to',
        match: /\bwill (?:send|share|follow up|schedule)\b/i,
      },
    ],
    words: { min: 5, max: 120 },
  },
};
