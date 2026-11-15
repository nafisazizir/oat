import type { JSONContent } from '@tiptap/core';

import type { MentionItem } from '../src/extensions.ts';

const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const p = (origin: 'me' | 'ai', ...content: JSONContent[]): JSONContent => ({
  type: 'paragraph',
  attrs: { origin },
  content,
});
const li = (origin: 'me' | 'ai', ...content: JSONContent[]): JSONContent => ({
  type: 'listItem',
  attrs: { origin },
  content: [p(origin, ...content)],
});
const task = (origin: 'me' | 'ai', checked: boolean, ...content: JSONContent[]): JSONContent => ({
  type: 'taskItem',
  attrs: { origin, checked },
  content: [p(origin, ...content)],
});
const h = (level: 1 | 2 | 3, origin: 'me' | 'ai', value: string): JSONContent => ({
  type: 'heading',
  attrs: { level, origin },
  content: [text(value)],
});

export const PEOPLE: MentionItem[] = [
  { id: 'u_priya', label: 'Priya Natarajan', description: 'priya@example.com' },
  { id: 'u_marco', label: 'Marco Rossi', description: 'marco@example.com' },
  { id: 'u_sam', label: 'Sam Okafor', description: 'sam@example.com' },
  { id: 'u_lea', label: 'Léa Martin', description: 'lea@example.com' },
];

export function searchPeople(query: string): MentionItem[] {
  const q = query.toLowerCase();
  return PEOPLE.filter((person) => person.label.toLowerCase().includes(q)).slice(0, 6);
}

/** An enhanced meeting note: my rough notes (`me`) woven with AI-added blocks (`ai`). */
export const SAMPLE_DOC: JSONContent = {
  type: 'doc',
  content: [
    h(2, 'me', 'Onboarding drop-off'),
    p(
      'me',
      text('Calendar step is where people leave — '),
      text('mostly skipping', [{ type: 'bold' }]),
      text(', not failing the permission prompt.'),
    ),
    p(
      'ai',
      text('About a third of new users never return to connect a calendar. '),
      { type: 'mention', attrs: { id: 'u_priya', label: 'Priya Natarajan' } },
      text(' traced most of the skips to the '),
      text('Connect later', [{ type: 'code' }]),
      text(' button on the second screen.'),
    ),
    {
      type: 'bulletList',
      attrs: { origin: 'me' },
      content: [
        li('me', text('make calendar optional')),
        li(
          'ai',
          text('Ask again after the first recorded meeting, when the value is '),
          text('obvious', [{ type: 'italic' }]),
          text('.'),
        ),
        li('ai', text('Keep the old flow behind a flag for comparison.')),
      ],
    },
    {
      type: 'callout',
      attrs: { emoji: '💡', variant: 'info', origin: 'ai' },
      content: [
        p(
          'ai',
          text('Decision: ', [{ type: 'bold' }]),
          text('ship the optional step to 20% of sign-ups first and '),
          text('watch activation', [{ type: 'highlight' }]),
          text('.'),
        ),
      ],
    },
    h(3, 'ai', 'Action items'),
    {
      type: 'taskList',
      attrs: { origin: 'ai' },
      content: [
        task(
          'ai',
          false,
          { type: 'mention', attrs: { id: 'u_marco', label: 'Marco Rossi' } },
          text(' prototype the deferred calendar prompt by Thursday'),
        ),
        task('me', true, text('send Priya the funnel dashboard')),
      ],
    },
    {
      type: 'blockquote',
      attrs: { origin: 'me' },
      content: [p('me', text('“If it’s optional, make it feel optional.”'))],
    },
    {
      type: 'codeBlock',
      attrs: { origin: 'ai' },
      content: [text("flags.set('onboarding.calendar-optional', { rollout: 0.2 })")],
    },
    { type: 'horizontalRule', attrs: { origin: 'me' } },
    p(
      'me',
      text('Spec: '),
      text('oat.app/specs/onboarding', [
        { type: 'link', attrs: { href: 'https://oat.app/specs/onboarding' } },
      ]),
      text(' · '),
      text('struck idea', [{ type: 'strike' }]),
    ),
  ],
};

export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
