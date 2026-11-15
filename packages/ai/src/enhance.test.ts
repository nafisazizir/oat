import { describe, expect, it } from 'vitest';
import {
  blockContent,
  buildEnhancePrompt,
  ENHANCE_MAX_OUTPUT_TOKENS,
  type EnhanceInput,
  enhanceNotes,
  type EnhanceOutput,
  enhanceOutputSchema,
  flattenBlocks,
  formatTranscript,
  renderMeta,
} from './enhance.ts';
import { createMockModel } from './testing.ts';

const input: EnhanceInput = {
  meta: {
    title: 'Roadmap sync',
    startedAt: '2026-11-12T10:00:00Z',
    attendees: [
      { name: 'Ana', me: true },
      { name: 'Ben', role: 'designer' },
    ],
  },
  template: {
    name: 'General',
    instructions: 'Keep it short.',
    sections: [
      { heading: 'Summary', instructions: 'What happened.' },
      { heading: 'Action items', instructions: '' },
    ],
  },
  myNotes: '- ship friday',
  transcript: [
    { source: 'mic', startMs: 1500, endMs: 3000, text: 'We ship Friday.' },
    { source: 'system', startMs: 61_000, endMs: 62_000, text: 'Agreed.' },
  ],
};

const nested: EnhanceOutput = {
  sections: [
    {
      heading: 'Summary',
      blocks: [
        { kind: 'paragraph', text: 'Release planning.', origin: 'ai' },
        {
          kind: 'bullet',
          text: 'ship friday',
          origin: 'me',
          children: [
            {
              kind: 'bullet',
              text: 'Ben confirmed the designs are final.',
              origin: 'ai',
              children: [{ kind: 'bullet', text: 'Icons still pending.', origin: 'ai' }],
            },
          ],
        },
      ],
    },
    {
      heading: 'Action items',
      blocks: [
        {
          kind: 'task',
          text: 'Send release notes',
          origin: 'ai',
          owner: 'Ana',
          due: 'Thursday',
          children: [{ kind: 'task', text: 'Draft changelog', origin: 'ai' }],
        },
      ],
    },
  ],
};

describe('enhanceOutputSchema', () => {
  it('accepts nested list items and task owner/due', () => {
    expect(enhanceOutputSchema.parse(nested)).toEqual(nested);
  });

  it('rejects children on paragraphs, owner on bullets, and unknown kinds', () => {
    const bad = (block: unknown) => ({ sections: [{ heading: 'S', blocks: [block] }] });
    const child = { kind: 'bullet', text: 'x', origin: 'ai' };
    for (const block of [
      { kind: 'paragraph', text: 'p', origin: 'ai', children: [child] },
      { kind: 'bullet', text: 'b', origin: 'ai', owner: 'Ana' },
      {
        kind: 'bullet',
        text: 'b',
        origin: 'ai',
        children: [{ kind: 'paragraph', text: 'p', origin: 'ai' }],
      },
      { kind: 'heading', text: 'h', origin: 'ai' },
      { kind: 'task', text: '', origin: 'ai' },
    ]) {
      // zod objects strip unknown keys by default, so check the parsed value didn't keep them either.
      const parsed = enhanceOutputSchema.safeParse(bad(block));
      expect(
        !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(bad(block)),
        JSON.stringify(block),
      ).toBe(true);
    }
  });

  it('flattens depth-first and renders task fields', () => {
    const all = flattenBlocks(nested.sections.flatMap((s) => s.blocks));
    expect(all.map((b) => b.text)).toEqual([
      'Release planning.',
      'ship friday',
      'Ben confirmed the designs are final.',
      'Icons still pending.',
      'Send release notes',
      'Draft changelog',
    ]);
    expect(blockContent(all[4]!)).toBe('Send release notes · Owner: Ana · Due: Thursday');
    expect(blockContent(all[0]!)).toBe('Release planning.');
  });
});

describe('formatTranscript', () => {
  it('labels mic as the user and system as others, with mm:ss', () => {
    expect(formatTranscript(input.transcript, input.meta)).toBe(
      '[00:01] Ana: We ship Friday.\n[01:01] Others: Agreed.',
    );
    expect(formatTranscript(input.transcript, { attendees: [] })).toContain('Me: We ship');
  });
});

describe('renderMeta', () => {
  it('renders title, a readable UTC date, attendees with roles and the speaker-label key', () => {
    expect(renderMeta(input.meta)).toBe(
      [
        'Meeting: Roadmap sync',
        'Date: Thursday, November 12, 2026 at 10:00 UTC (2026-11-12T10:00:00Z)',
        'Attendees:',
        '- Ana (me, the note-taker)',
        '- Ben (designer)',
        'Transcript speaker labels: "Ana" lines come from the note-taker\'s microphone. "Others" is everyone ' +
          'else on the call (shared audio), so which other attendee said a line must be inferred from context, ' +
          'names used and the attendee list.',
      ].join('\n'),
    );
    expect(renderMeta({ ...input.meta, startedAt: 'soon' })).toContain('Date: soon');
  });
});

describe('buildEnhancePrompt', () => {
  it('carries metadata, ordered sections, my notes and the transcript', () => {
    const { system, prompt } = buildEnhancePrompt(input);
    expect(system).toContain('origin "me"');
    expect(prompt).toContain(renderMeta(input.meta));
    expect(prompt).toContain('1. Summary — What happened.\n2. Action items');
    expect(prompt).toContain('My notes:\n- ship friday');
    expect(prompt).toContain('[01:01] Others: Agreed.');
  });
});

describe('enhanceNotes (placeholder)', () => {
  it('returns schema-validated structured output, with temperature and an output cap', async () => {
    const model = createMockModel({ responses: [JSON.stringify(nested)] });
    expect(await enhanceNotes(input, { model, temperature: 0 })).toEqual(nested);
    const call = model.doGenerateCalls[0]!;
    expect(call.responseFormat).toMatchObject({ type: 'json' });
    expect(call.temperature).toBe(0);
    expect(call.maxOutputTokens).toBe(ENHANCE_MAX_OUTPUT_TOKENS);

    await enhanceNotes(input, { model, maxOutputTokens: 100 });
    expect(model.doGenerateCalls[1]).toMatchObject({
      temperature: undefined,
      maxOutputTokens: 100,
    });
  });

  it('throws when the model output does not match the schema', async () => {
    const model = createMockModel({
      responses: [JSON.stringify({ sections: [{ heading: 'x' }] })],
    });
    await expect(enhanceNotes(input, { model })).rejects.toThrow();
  });
});
