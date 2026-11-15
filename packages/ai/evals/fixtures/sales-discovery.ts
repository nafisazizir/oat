import type { EnhanceFixture } from '../../src/evals/enhance-suite.ts';
import { timed } from './helpers.ts';

/**
 * Text-only discovery call (all names and companies invented). Riley (mic) sells scheduling software; Tomás runs
 * operations at a dental group. Dense with numbers, names and dates that must come through exactly.
 */
export const salesDiscovery: EnhanceFixture = {
  id: 'sales-discovery',
  description:
    'Longer call with many specific figures, a hard requirement, two other stakeholders and dated next steps.',
  meta: {
    title: 'Brightwell × Pinecrest Dental — discovery',
    startedAt: '2026-11-13T15:00:00Z',
    attendees: [
      { name: 'Riley Park', me: true, role: 'account executive, Brightwell' },
      { name: 'Tomás Reyes', role: 'Head of Operations, Pinecrest Dental Group' },
    ],
  },
  templateId: 'sales-discovery',
  myNotes: `## pinecrest
- 14 clinics
- no-shows = big pain
- dentacore integration MUST
- budget ~40k/yr?
- todo: send soc2 + docs`,
  transcript: timed([
    [
      'mic',
      'Thanks for taking the time, Tomás. Could you start by telling me a bit about Pinecrest?',
    ],
    [
      'system',
      'Sure. We are a dental group with fourteen clinics across the region, about two hundred and twenty staff in total.',
    ],
    [
      'system',
      'And we are opening three more clinics in the spring, so things are about to get busier.',
    ],
    ['mic', 'Congratulations. What made you take this call now?'],
    [
      'system',
      'Honestly, no-shows. Our no-show rate is around eighteen percent, and every empty chair is lost revenue.',
    ],
    [
      'system',
      'On top of that, our hygienists get double-booked a couple of times a week because each clinic keeps its own spreadsheet.',
    ],
    ['mic', 'How do patients get reminded about appointments today?'],
    [
      'system',
      'The front desk calls them. That takes roughly two hours a day per clinic, and people mostly ignore the calls anyway.',
    ],
    ['mic', 'Have you tried any tools for this before?'],
    [
      'system',
      'Two years ago we tried a reminder app, but it did not sync with DentaCore, which is our practice management system.',
    ],
    ['system', 'Staff had to enter everything twice, so we dropped it after about three months.'],
    ['mic', 'So working with DentaCore is a hard requirement?'],
    [
      'system',
      'Absolutely. If it does not read and write appointments in DentaCore, it is a non-starter for us.',
    ],
    [
      'mic',
      'Understood. We have a native DentaCore integration that syncs both ways every minute. I can send you the technical docs.',
    ],
    ['system', 'Please do. Our IT lead will want to see them.'],
    ['mic', 'Who else is involved in a decision like this?'],
    [
      'system',
      'I own the decision on the operations side, but Mei Lin, our CFO, signs off on anything over twenty thousand.',
    ],
    [
      'system',
      'And Arjun, our IT lead, has to review security. He will ask for your SOC 2 report before anything else.',
    ],
    ['mic', 'That is no problem. Do you have a budget in mind?'],
    [
      'system',
      'We have approval for up to forty thousand dollars a year. Our fiscal year starts on July first, so timing matters.',
    ],
    ['mic', 'And what timeline are you hoping for?'],
    [
      'system',
      'We would like a pilot in two clinics by March, and a full rollout before the new clinics open.',
    ],
    ['mic', 'Which two clinics would you pilot in?'],
    [
      'system',
      'Probably Lakeside and Mill Street. They have the worst no-show numbers, so we would see the difference quickly.',
    ],
    ['mic', 'Makes sense. How would you measure success for the pilot?'],
    [
      'system',
      'If we can bring no-shows under ten percent in those two clinics and free up the front desk, that would convince Mei.',
    ],
    [
      'mic',
      'Great. Here is what I suggest. I will send the SOC 2 report and the DentaCore integration docs by Wednesday.',
    ],
    ['mic', 'I will also put together a pilot proposal with pricing for Lakeside and Mill Street.'],
    [
      'system',
      'Sounds good. I will set up a call with Arjun for next week so he can go through security.',
    ],
    ['mic', 'Perfect. Thanks, Tomás, this was really helpful.'],
  ]),
  expect: {
    mustMention: [
      {
        id: 'clinics',
        kind: 'fact',
        description: 'Pinecrest has 14 clinics and about 220 staff.',
        match: /\b14\b|fourteen/i,
      },
      {
        id: 'expansion',
        kind: 'fact',
        description: 'Three more clinics open in the spring.',
        match: [/three|\b3\b/i, /spring/i],
      },
      {
        id: 'no-show-rate',
        kind: 'fact',
        description: 'No-show rate is around 18%.',
        match: /eighteen percent|18\s?%/i,
      },
      {
        id: 'double-booking',
        kind: 'fact',
        description: 'Hygienists get double-booked because each clinic uses its own spreadsheet.',
        match: /double-?\s?booked|double booking/i,
      },
      {
        id: 'reminder-calls',
        kind: 'fact',
        description: 'Front desk spends about two hours a day per clinic on reminder calls.',
        match: [/two hours|2 hours/i],
      },
      {
        id: 'dentacore',
        kind: 'decision',
        description:
          'Two-way DentaCore integration is a hard requirement (a previous app failed without it).',
        match: /DentaCore/,
      },
      {
        id: 'budget',
        kind: 'fact',
        description: 'Approved budget up to $40,000 per year; fiscal year starts July 1.',
        match: /forty thousand|\$?40,?000|\$?40k/i,
      },
      {
        id: 'pilot',
        kind: 'decision',
        description: 'Pilot in two clinics (Lakeside and Mill Street) by March.',
        match: [/pilot/i, /March/],
      },
      {
        id: 'stakeholders',
        kind: 'fact',
        description: 'Mei Lin (CFO) signs off over $20k; Arjun (IT lead) reviews security.',
        match: [/Mei/, /\bCFO\b|chief financial officer/i],
      },
      {
        id: 'send-soc2',
        kind: 'action',
        description: 'Riley sends the SOC 2 report and DentaCore docs by Wednesday.',
        match: [/SOC ?2/i, /Wednesday/i],
        owner: /\bRiley\b/,
      },
      {
        id: 'pilot-proposal',
        kind: 'action',
        description: 'Riley prepares a pilot proposal with pricing.',
        match: [/proposal/i],
        owner: /\bRiley\b/,
      },
      {
        id: 'arjun-call',
        kind: 'action',
        description: 'Tomás sets up a security call with Arjun next week.',
        match: [/Arjun/, /call|meeting/i],
        owner: /\bTom[aá]s\b/,
      },
    ],
    mustNotMention: [
      {
        id: 'wrong-budget',
        description: 'a budget figure other than $40k (or the $20k sign-off threshold)',
        match:
          /\$\s?(?!(?:20|40)(?:,000|k)\b)\d{1,3}(?:,000|k)\b|\b(?:thirty|fifty|sixty|hundred) thousand\b/i,
      },
      {
        id: 'wrong-clinic-count',
        description: 'a clinic count other than 14 (or 3 new, 2 pilot, 17 after opening)',
        match: /\b(?:1[0-35689]|[4-9]|[2-9]\d)\s+clinics\b/i,
      },
      {
        id: 'invented-titles',
        description: 'roles nobody holds in the transcript',
        match: /\b(?:CEO|CTO|COO|procurement)\b/,
      },
      {
        id: 'wrong-month',
        description: 'months never mentioned (March, July; November is the meeting date)',
        match: /\b(?:January|February|April|May|June|August|September|October|December)\b/,
      },
    ],
    words: { min: 120, max: 700 },
  },
};
