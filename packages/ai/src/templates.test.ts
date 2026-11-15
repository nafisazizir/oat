import { TemplateSchema } from '@oat/core';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATE_SLUGS,
  BUILTIN_TEMPLATES,
  copyName,
  DEFAULT_TEMPLATE,
  getBuiltinTemplate,
  isBuiltinTemplateId,
  renderTemplate,
  TEMPLATE_LIMITS,
  templateInputSchema,
  templatePatchSchema,
} from './templates.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('built-in templates', () => {
  it('are the five SPEC §4 templates, in a fixed order with fixed ids', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.slug)).toEqual([...BUILTIN_TEMPLATE_SLUGS]);
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual([
      'General',
      '1:1',
      'Sales discovery',
      'Standup',
      'Interview',
    ]);
    // Ids are persisted (meeting.template_id): changing one orphans references. Pin them.
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual([
      '01900000-0000-7000-8b17-000000000001',
      '01900000-0000-7000-8b17-000000000002',
      '01900000-0000-7000-8b17-000000000003',
      '01900000-0000-7000-8b17-000000000004',
      '01900000-0000-7000-8b17-000000000005',
    ]);
    for (const t of BUILTIN_TEMPLATES) expect(t.id).toMatch(UUID_V7);
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.slug, t] as const))(
    '%s satisfies the core contract and the editor limits',
    (_slug, template) => {
      expect(TemplateSchema.parse(template)).toMatchObject({ isBuiltin: true, workspaceId: null });
      expect(templateInputSchema.parse(template)).toEqual({
        name: template.name,
        instructions: template.instructions,
        sections: template.sections,
      });
      expect(template.instructions.length).toBeGreaterThan(20);
      for (const s of template.sections) expect(s.instructions.length).toBeGreaterThan(20);
    },
  );

  it('are frozen', () => {
    const general = BUILTIN_TEMPLATES[0]!;
    expect(Object.isFrozen(general)).toBe(true);
    expect(Object.isFrozen(general.sections)).toBe(true);
    expect(Object.isFrozen(general.sections[0])).toBe(true);
  });

  it('are found by id or slug', () => {
    const standup = getBuiltinTemplate('standup')!;
    expect(getBuiltinTemplate(standup.id)).toBe(standup);
    expect(isBuiltinTemplateId(standup.id)).toBe(true);
    expect(isBuiltinTemplateId('standup')).toBe(false);
    expect(getBuiltinTemplate('nope')).toBeUndefined();
    expect(DEFAULT_TEMPLATE.slug).toBe('general');
  });
});

describe('templateInputSchema', () => {
  const valid = {
    name: '  Design review ',
    instructions: ' For crits. ',
    sections: [
      { heading: ' Feedback ', instructions: ' What people said. ' },
      { heading: 'Next steps', instructions: '' },
    ],
  };

  it('trims every field', () => {
    expect(templateInputSchema.parse(valid)).toEqual({
      name: 'Design review',
      instructions: 'For crits.',
      sections: [
        { heading: 'Feedback', instructions: 'What people said.' },
        { heading: 'Next steps', instructions: '' },
      ],
    });
  });

  it.each([
    ['an empty name', { ...valid, name: '   ' }, /name can’t be empty/],
    ['a multi-line name', { ...valid, name: 'a\nb' }, /single line/],
    ['a long name', { ...valid, name: 'x'.repeat(TEMPLATE_LIMITS.name + 1) }, /80 characters/],
    ['no sections', { ...valid, sections: [] }, /at least one section/],
    [
      'too many sections',
      {
        ...valid,
        sections: Array.from({ length: 13 }, (_, i) => ({ heading: `S${i}`, instructions: '' })),
      },
      /at most 12/,
    ],
    [
      'duplicate headings (case-insensitive)',
      {
        ...valid,
        sections: [
          { heading: 'Notes', instructions: '' },
          { heading: 'notes ', instructions: '' },
        ],
      },
      /unique/,
    ],
    [
      'an empty heading',
      { ...valid, sections: [{ heading: ' ', instructions: 'x' }] },
      /heading can’t be empty/,
    ],
    [
      'long section instructions',
      { ...valid, sections: [{ heading: 'A', instructions: 'x'.repeat(1001) }] },
      /1000 characters/,
    ],
  ])('rejects %s', (_label, input, message) => {
    const result = templateInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(message);
  });

  it('patches need at least one field', () => {
    expect(templatePatchSchema.safeParse({}).success).toBe(false);
    expect(templatePatchSchema.parse({ name: ' New ' })).toEqual({ name: 'New' });
  });
});

describe('copyName', () => {
  it('appends (copy), then numbers further copies', () => {
    expect(copyName('General')).toBe('General (copy)');
    expect(copyName('General', ['General (copy)'])).toBe('General (copy 2)');
    expect(copyName('General (copy)', ['General (copy)', 'General (copy 2)'])).toBe(
      'General (copy 3)',
    );
  });

  it('stays within the name limit', () => {
    expect(copyName('x'.repeat(80)).length).toBe(TEMPLATE_LIMITS.name);
  });
});

describe('renderTemplate', () => {
  it('lists sections in order with their instructions', () => {
    expect(
      renderTemplate({
        name: 'Retro',
        instructions: 'Blameless.',
        sections: [
          { heading: 'Went well', instructions: 'Wins.' },
          { heading: 'Change', instructions: '' },
        ],
      }),
    ).toBe(
      [
        'Template: Retro',
        'About this template: Blameless.',
        'Sections, in this order:',
        '1. Went well — Wins.',
        '2. Change',
      ].join('\n'),
    );
  });
});
