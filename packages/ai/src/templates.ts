/**
 * Note templates (D-20, SPEC §4 Enhance): a title (`name`), a description (`instructions`: what the template is
 * for and any note-wide guidance) and ordered sections `{ heading, instructions }`. One prompt builder serves
 * every template, built-in or custom, so a built-in is just data in the same shape.
 *
 * Built-ins have fixed ids and are upserted into Postgres as `is_builtin` rows (`@oat/db`
 * `upsertBuiltinTemplates`), so `meeting.template_id` can point at them like at any custom template. All wording
 * here is Oat's own.
 *
 * Browser-safe: no AI SDK imports (the web template editor validates with these schemas).
 */
import type { Template, TemplateSection } from '@oat/core';
import { z } from 'zod';

/** Field limits shared by the API and the editor. */
export const TEMPLATE_LIMITS = {
  name: 80,
  instructions: 1000,
  heading: 100,
  sectionInstructions: 1000,
  minSections: 1,
  maxSections: 12,
} as const;

const singleLine = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `${what} can’t be empty.`)
    .max(max, `${what} must be ${max} characters or fewer.`)
    .refine((s) => !/[\r\n]/.test(s), `${what} must be a single line.`);

export const templateSectionInputSchema = z.object({
  heading: singleLine(TEMPLATE_LIMITS.heading, 'Section heading'),
  instructions: z
    .string()
    .trim()
    .max(
      TEMPLATE_LIMITS.sectionInstructions,
      `Section instructions must be ${TEMPLATE_LIMITS.sectionInstructions} characters or fewer.`,
    ),
});

/** What a user can set on a custom template (create / full update). Trims every field. */
export const templateInputSchema = z.object({
  name: singleLine(TEMPLATE_LIMITS.name, 'Template name'),
  instructions: z
    .string()
    .trim()
    .max(
      TEMPLATE_LIMITS.instructions,
      `Description must be ${TEMPLATE_LIMITS.instructions} characters or fewer.`,
    ),
  sections: z
    .array(templateSectionInputSchema)
    .min(TEMPLATE_LIMITS.minSections, 'Add at least one section.')
    .max(TEMPLATE_LIMITS.maxSections, `Use at most ${TEMPLATE_LIMITS.maxSections} sections.`)
    .refine(
      (sections) =>
        new Set(sections.map((s) => s.heading.toLocaleLowerCase())).size === sections.length,
      'Section headings must be unique.',
    ),
});
export type TemplateInput = z.infer<typeof templateInputSchema>;

/** Partial update; at least one field. */
export const templatePatchSchema = templateInputSchema
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to update.');
export type TemplatePatch = z.infer<typeof templatePatchSchema>;

/** Stable slugs of the built-ins (eval fixtures reference templates by slug). */
export const BUILTIN_TEMPLATE_SLUGS = [
  'general',
  'one-on-one',
  'sales-discovery',
  'standup',
  'interview',
] as const;
export type BuiltinTemplateSlug = (typeof BUILTIN_TEMPLATE_SLUGS)[number];

export interface BuiltinTemplate extends Omit<Template, 'workspaceId' | 'isBuiltin'> {
  slug: BuiltinTemplateSlug;
  workspaceId: null;
  isBuiltin: true;
  sections: TemplateSection[];
}

/** Fixed UUIDv7-shaped ids (never change them: meetings and enhancements reference them). */
const builtinId = (n: number) => `01900000-0000-7000-8b17-${n.toString(16).padStart(12, '0')}`;

const builtin = (
  n: number,
  slug: BuiltinTemplateSlug,
  name: string,
  instructions: string,
  sections: TemplateSection[],
): BuiltinTemplate =>
  Object.freeze({
    id: builtinId(n),
    slug,
    workspaceId: null,
    name,
    instructions,
    sections: Object.freeze(sections.map((s) => Object.freeze(s))) as TemplateSection[],
    isBuiltin: true as const,
  });

/** The five built-ins, in display order. General is the default. */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = Object.freeze([
  builtin(
    1,
    'general',
    'General',
    'Fits most meetings. Someone who missed the call should be able to read it in a minute and know what ' +
      'happened, what was settled and what happens next.',
    [
      {
        heading: 'Summary',
        instructions:
          'Two to four sentences on why the meeting happened and where it ended up. Lead with the outcome, ' +
          'not the agenda.',
      },
      {
        heading: 'Discussion',
        instructions:
          'The topics that took real time, in the order they came up: one bullet per topic with the key ' +
          'points nested under it. Keep names, numbers and dates exactly as they were said.',
      },
      {
        heading: 'Decisions',
        instructions:
          'What the group agreed on, each as a plain statement. Leave the section empty rather than turning ' +
          'an open question into a decision.',
      },
      {
        heading: 'Action items',
        instructions:
          'One task per commitment: what, who owns it, and when if a time was mentioned. Only things ' +
          'someone actually agreed to do.',
      },
    ],
  ),
  builtin(
    2,
    'one-on-one',
    '1:1',
    'A recurring check-in between a manager and a report. Keeps track of progress, what is on either ' +
      'person’s mind and what each of them promised to do.',
    [
      {
        heading: 'Updates',
        instructions:
          'What moved since the last check-in: work shipped, progress, results and any figures mentioned.',
      },
      {
        heading: 'Challenges and support',
        instructions:
          'Blockers, worries or friction raised by either person, and any help offered or asked for.',
      },
      {
        heading: 'Feedback and growth',
        instructions:
          'Feedback in either direction, career goals, and new responsibilities or opportunities that came up.',
      },
      {
        heading: 'Action items',
        instructions: 'Follow-ups, each with an owner, and a timeframe when one was given.',
      },
    ],
  ),
  builtin(
    3,
    'sales-discovery',
    'Sales discovery',
    'An early call with a prospect. Captures what a seller needs to qualify the deal and write a ' +
      'proposal, in the prospect’s own terms.',
    [
      {
        heading: 'About the prospect',
        instructions:
          'Who they are: company, team, size, growth plans, and the people on the call with their roles.',
      },
      {
        heading: 'Pains and goals',
        instructions:
          'Problems they described, the impact and any numbers they gave, and what success would look like.',
      },
      {
        heading: 'Current setup',
        instructions:
          'How they handle this today: tools, vendors, workarounds and anything they tried before.',
      },
      {
        heading: 'Requirements',
        instructions:
          'Must-haves, nice-to-haves and deal-breakers, including security, compliance and integrations.',
      },
      {
        heading: 'Budget and timeline',
        instructions:
          'Budget, reactions to pricing, deadlines and dates. Write amounts and dates exactly as stated; ' +
          'never estimate.',
      },
      {
        heading: 'Decision process',
        instructions:
          'Who decides, who else has a say, what they need to see, and any alternatives they are weighing.',
      },
      {
        heading: 'Next steps',
        instructions: 'Agreed follow-ups on both sides, with owner and date.',
      },
    ],
  ),
  builtin(
    4,
    'standup',
    'Standup',
    'A short team sync. Group updates by person so anyone can scan who did what and who is stuck.',
    [
      {
        heading: 'Done',
        instructions: 'What each person finished since the last standup, under their name.',
      },
      {
        heading: 'Up next',
        instructions: 'What each person is picking up next, under their name.',
      },
      {
        heading: 'Blockers',
        instructions:
          'What is stopping progress, who is blocked and who can help. Leave empty if nobody raised one.',
      },
      {
        heading: 'Follow-ups',
        instructions: 'Things someone agreed to do after the standup, with an owner.',
      },
    ],
  ),
  builtin(
    5,
    'interview',
    'Interview',
    'A candidate interview. Record evidence, not impressions, so the panel can score fairly. Never add a ' +
      'hire or no-hire verdict.',
    [
      {
        heading: 'Background',
        instructions:
          'Current role, relevant experience and what they are looking for, as the candidate described it.',
      },
      {
        heading: 'Skills and depth',
        instructions:
          'What they built and how they reasoned about it: approaches, trade-offs and the specifics they ' +
          'gave. Use their examples.',
      },
      {
        heading: 'Collaboration',
        instructions:
          'How they work with others: teamwork, mentoring, handling disagreement, how clearly they explain.',
      },
      {
        heading: 'Strengths and concerns',
        instructions:
          'Strong signals and open risks or gaps, each tied to something said in the interview.',
      },
      {
        heading: 'Logistics and next steps',
        instructions:
          'Notice period and availability, expectations if mentioned, the candidate’s questions, and agreed ' +
          'next steps.',
      },
    ],
  ),
]);

/** The template used when none is chosen. */
export const DEFAULT_TEMPLATE_SLUG: BuiltinTemplateSlug = 'general';

const byId = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));
const bySlug = new Map(BUILTIN_TEMPLATES.map((t) => [t.slug, t]));

export function isBuiltinTemplateId(id: string): boolean {
  return byId.has(id);
}

/** A built-in by id or slug. */
export function getBuiltinTemplate(idOrSlug: string): BuiltinTemplate | undefined {
  return byId.get(idOrSlug) ?? bySlug.get(idOrSlug as BuiltinTemplateSlug);
}

export const DEFAULT_TEMPLATE: BuiltinTemplate = getBuiltinTemplate(DEFAULT_TEMPLATE_SLUG)!;

/** Name for a duplicate: "General" → "General (copy)", "General (copy)" → "General (copy 2)". */
export function copyName(name: string, taken: Iterable<string> = []): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  const used = new Set(taken);
  const fits = (s: string) => s.slice(0, TEMPLATE_LIMITS.name);
  let candidate = fits(`${base} (copy)`);
  for (let n = 2; used.has(candidate); n++) candidate = fits(`${base} (copy ${n})`);
  return candidate;
}

/** Plain-text rendering of a template, as the enhance prompt shows it (and the editor previews it). */
export function renderTemplate(template: {
  name: string;
  instructions: string;
  sections: readonly TemplateSection[];
}): string {
  const lines = [`Template: ${template.name}`];
  if (template.instructions.trim())
    lines.push(`About this template: ${template.instructions.trim()}`);
  lines.push('Sections, in this order:');
  template.sections.forEach((s, i) => {
    const how = s.instructions.trim();
    lines.push(`${i + 1}. ${s.heading}${how ? ` — ${how}` : ''}`);
  });
  return lines.join('\n');
}
