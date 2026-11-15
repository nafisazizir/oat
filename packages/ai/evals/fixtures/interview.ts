import type { EnhanceFixture } from '../../src/evals/enhance-suite.ts';
import { timed } from './helpers.ts';

/**
 * Text-only technical interview (all names invented). Jamie (mic) interviews Elena for a senior backend role.
 * Mixes strengths, explicit gaps, logistics and follow-ups; salary is never discussed.
 */
export const interview: EnhanceFixture = {
  id: 'interview',
  description:
    'Longer interview: evidence for strengths and gaps must be kept apart, and nothing about pay may be invented.',
  meta: {
    title: 'Senior Backend Engineer — Elena Petrova',
    startedAt: '2026-11-13T10:00:00Z',
    attendees: [
      { name: 'Jamie Okafor', me: true, role: 'interviewer' },
      { name: 'Elena Petrova', role: 'candidate, Senior Backend Engineer' },
    ],
  },
  templateId: 'interview',
  myNotes: `* 6 yrs, payments startup
* retry system / idempotency - strong
* rate limiter: token bucket, redis
* weak: frontend, k8s
* notice 4 wks`,
  transcript: timed([
    ['mic', 'Hi Elena, thanks for joining. Could you walk me through your background?'],
    [
      'system',
      'Sure. I have been a backend engineer for six years. For the last three I have been at a payments startup.',
    ],
    [
      'system',
      'There I led the move from our monolith to a handful of services, with a team of four engineers.',
    ],
    ['mic', 'What is the piece of work you are proudest of there?'],
    [
      'system',
      'Probably the payment retry system. We had duplicate charges when clients retried after a timeout.',
    ],
    [
      'system',
      'I designed it around idempotency keys stored in Postgres with a unique constraint, so a retried request returns the original result.',
    ],
    ['system', 'After it shipped, duplicate charges went to essentially zero.'],
    ['mic', 'Nice. How did you handle a key arriving while the first request was still running?'],
    [
      'system',
      'The first request holds a row lock, so the second one waits briefly and then either gets the stored response or a conflict error telling the client to retry later.',
    ],
    ['mic', 'Let us do a design question. How would you build a rate limiter for our public API?'],
    [
      'system',
      'I would use a token bucket per tenant, kept in Redis, with the refill computed lazily on each request.',
    ],
    [
      'system',
      'Limits would be configurable per plan, and I would return the remaining budget in response headers.',
    ],
    ['mic', 'What happens if Redis is unavailable?'],
    [
      'system',
      'I would fail open for read endpoints so customers are not locked out, and fail closed for write endpoints to protect the database.',
    ],
    ['mic', 'How do you work with product managers when you disagree?'],
    [
      'system',
      'Last year a PM wanted a feature that would have doubled our database load. I wrote a short design doc comparing three options with their costs, and we picked a cheaper one together.',
    ],
    ['system', 'I also mentor two junior engineers, mostly through pairing and code review.'],
    ['mic', 'Are there areas where you would need to ramp up?'],
    [
      'system',
      'Frontend, definitely. I have done very little React. And I have not run Kubernetes myself; we used a managed platform.',
    ],
    ['mic', 'That is helpful, thanks. Do you have questions for me?'],
    ['system', 'How often would I be on call?'],
    ['mic', 'The rotation is one week every six weeks, with a day off after a busy week.'],
    ['system', 'Good. And what is the notice period you would need from me? Mine is four weeks.'],
    ['mic', 'Four weeks is fine. I will submit my scorecard by end of day today.'],
    ['mic', 'Sam from recruiting will reach out to schedule the final round.'],
    ['system', 'Great, thank you, Jamie.'],
  ]),
  expect: {
    mustMention: [
      {
        id: 'experience',
        kind: 'fact',
        description: 'Six years as a backend engineer, last three at a payments startup.',
        match: [/six|\b6\b/i, /y(?:ea)?rs/i],
      },
      {
        id: 'migration',
        kind: 'fact',
        description: 'Led the monolith-to-services migration with a team of four.',
        match: /monolith/i,
      },
      {
        id: 'idempotency',
        kind: 'fact',
        description:
          'Built payment retries on idempotency keys in Postgres with a unique constraint.',
        match: /idempoten/i,
      },
      {
        id: 'duplicate-charges',
        kind: 'fact',
        description: 'Duplicate charges dropped to essentially zero.',
        match: /duplicate charges/i,
      },
      {
        id: 'token-bucket',
        kind: 'fact',
        description: 'Rate limiter design: per-tenant token bucket in Redis.',
        match: [/token bucket/i, /redis/i],
      },
      {
        id: 'redis-failure',
        kind: 'fact',
        description: 'If Redis is down: fail open for reads, fail closed for writes.',
        match: /fail(?:s|ing)? (?:open|closed)/i,
      },
      {
        id: 'disagreement',
        kind: 'fact',
        description: 'Resolved a disagreement with a PM by writing a design doc comparing options.',
        match: /design doc/i,
      },
      {
        id: 'mentoring',
        kind: 'fact',
        description: 'Mentors two junior engineers.',
        match: /mentor/i,
      },
      {
        id: 'gaps',
        kind: 'fact',
        description: 'Gaps: little frontend/React and no hands-on Kubernetes.',
        match: [/frontend|react/i],
      },
      {
        id: 'notice',
        kind: 'fact',
        description: 'Notice period is four weeks.',
        match: [/notice/i, /four weeks|4 w(?:ee)?ks/i],
      },
      {
        id: 'scorecard',
        kind: 'action',
        description: 'Jamie submits the scorecard by end of day.',
        match: /scorecard/i,
        owner: /\bJamie\b/,
      },
      {
        id: 'final-round',
        kind: 'action',
        description: 'Sam (recruiting) schedules the final round.',
        match: /final round/i,
        owner: /\bSam\b/,
      },
    ],
    mustNotMention: [
      {
        id: 'invented-pay',
        description: 'salary or compensation (never discussed)',
        match: /\$\s?\d|salary|compensation|equity/i,
      },
      {
        id: 'wrong-years',
        description: 'years of experience other than six (or three at the startup)',
        match: /\b(?:[457-9]|1\d|two|four|five|seven|eight|nine|ten) years\b/i,
      },
      {
        id: 'wrong-language',
        description: 'languages or tools never mentioned',
        match: /\b(?:Java|Golang|Rust|Python|Kafka|MySQL|DynamoDB)\b/,
      },
      {
        id: 'hire-verdict',
        description: 'a hiring verdict nobody gave',
        match: /\b(?:strong hire|no hire|hired|rejected)\b/i,
      },
    ],
    words: { min: 120, max: 700 },
  },
};
