/**
 * Templates the eval fixtures reference by id. Eval-local stand-ins written for 4.2; task 4.3 ships the real
 * built-ins (same shape: name, instructions, ordered sections) and should point fixtures at those.
 */
import type { EnhanceTemplate } from '../src/enhance.ts';

export const EVAL_TEMPLATES = {
  general: {
    name: 'General meeting',
    instructions: 'Concise notes anyone who missed the meeting can act on.',
    sections: [
      { heading: 'Summary', instructions: 'Two or three sentences on what the meeting was about.' },
      { heading: 'Discussion', instructions: 'The main topics, in the order they came up.' },
      { heading: 'Action items', instructions: 'Who does what, and by when if said.' },
    ],
  },
  'one-on-one': {
    name: 'One-on-one',
    instructions: 'Notes for a recurring manager / report check-in.',
    sections: [
      { heading: 'Updates', instructions: 'What the report shipped or worked on, with outcomes.' },
      {
        heading: 'Topics',
        instructions: 'Issues, career or project topics raised by either side.',
      },
      { heading: 'Action items', instructions: 'Follow-ups with an owner each.' },
    ],
  },
  standup: {
    name: 'Stand-up',
    instructions: 'Per-person progress, plans and blockers.',
    sections: [
      { heading: 'Done', instructions: 'What each person finished since the last stand-up.' },
      { heading: 'Today', instructions: 'What each person plans to do next.' },
      { heading: 'Blockers', instructions: 'Anything waiting on someone else.' },
      { heading: 'Action items', instructions: 'Follow-ups with an owner each.' },
    ],
  },
  'sales-discovery': {
    name: 'Sales discovery call',
    instructions: 'Qualify the prospect and capture what is needed for a proposal.',
    sections: [
      { heading: 'Company context', instructions: 'Who they are, size, growth plans.' },
      { heading: 'Pain points', instructions: 'Problems in their words, with any numbers given.' },
      {
        heading: 'Current process and tools',
        instructions: 'How they work today, what they tried.',
      },
      { heading: 'Requirements', instructions: 'Must-haves and deal-breakers.' },
      { heading: 'Budget and timeline', instructions: 'Amounts and dates exactly as stated.' },
      { heading: 'Decision process', instructions: 'Who decides, who reviews, what they need.' },
      { heading: 'Next steps', instructions: 'Follow-ups with owner and date.' },
    ],
  },
  interview: {
    name: 'Candidate interview',
    instructions: 'Evidence-based interview notes for a hiring scorecard.',
    sections: [
      { heading: 'Background', instructions: 'Experience and current role.' },
      { heading: 'Technical depth', instructions: 'What they built and how they reasoned.' },
      { heading: 'Collaboration', instructions: 'Teamwork, mentoring, handling disagreement.' },
      { heading: 'Concerns', instructions: 'Gaps or risks, with the evidence.' },
      {
        heading: 'Logistics and next steps',
        instructions: 'Notice period, questions asked, follow-ups.',
      },
    ],
  },
} satisfies Record<string, EnhanceTemplate>;

export type EvalTemplateId = keyof typeof EVAL_TEMPLATES;
