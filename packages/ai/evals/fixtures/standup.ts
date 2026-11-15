import raw from '../../../../fixtures/audio/standup-short.segments.json' with { type: 'json' };
import type { EnhanceFixture } from '../../src/evals/enhance-suite.ts';
import { segments } from './helpers.ts';

/** Two-person stand-up; transcript is the `standup-short` audio fixture's ground truth (mic = Alex). */
export const standup: EnhanceFixture = {
  id: 'standup',
  description:
    'Stand-up with one blocker that belongs to the other person and a follow-up Alex takes on.',
  meta: {
    title: 'Platform stand-up',
    startedAt: '2026-11-11T09:30:00Z',
    attendees: [
      { name: 'Alex Chen', me: true, role: 'engineer' },
      { name: 'Sam Rivera', role: 'engineer' },
    ],
  },
  templateId: 'standup',
  myNotes: `export btn PR up
flaky login test today
billing - waiting on finance`,
  transcript: segments(raw),
  expect: {
    mustMention: [
      {
        id: 'export-pr',
        kind: 'fact',
        description: 'Alex finished the export button and opened a pull request.',
        match: [/export/i, /pull request|\bPR\b/i],
      },
      {
        id: 'review-after-lunch',
        kind: 'action',
        description: 'Sam reviews the export PR after lunch.',
        match: [/review/i, /lunch/i],
        owner: /\bSam\b/,
      },
      {
        id: 'flaky-test',
        kind: 'fact',
        description: 'Alex is fixing the flaky login test today.',
        match: /flaky login test/i,
      },
      {
        id: 'billing-staging',
        kind: 'fact',
        description: 'The billing migration is running in staging.',
        match: [/billing migration/i, /staging/i],
      },
      {
        id: 'tax-rates',
        kind: 'fact',
        description: 'Billing is blocked on finance confirming the new tax rates.',
        match: [/finance/i, /tax rates?/i],
      },
      {
        id: 'ping-finance',
        kind: 'action',
        description: 'Alex pings finance about the tax rates.',
        match: [/finance/i, /ping|follow up|chase|contact|reach out/i],
        owner: /\bAlex\b/,
      },
    ],
    mustNotMention: [
      {
        id: 'invented-rate',
        description: 'a tax rate or other percentage (none was given)',
        match: /\d\s?%|percent/i,
      },
      {
        id: 'production',
        description: 'the migration running in production (it is in staging)',
        match: /\bin production\b/i,
      },
      {
        id: 'alex-blocked',
        description: 'Alex having blockers (Alex said none)',
        match: /\bAlex\b[^.]*\bblocked\b/i,
      },
    ],
    words: { min: 30, max: 300 },
  },
};
