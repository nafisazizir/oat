import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateFromSchema, type JsonSchema, UnsupportedSchemaError } from './json-schema.ts';
import { TextPool } from './text.ts';

const prompt = [
  { role: 'system', content: 'You turn meeting notes into clean notes.' },
  {
    role: 'user',
    content:
      'We agreed to ship the beta on Friday. Priya owns the launch checklist.\n- Budget is approved\n- Follow up with legal about the contract',
  },
];

function fill(schema: z.ZodType, target?: 'draft-7' | 'draft-2020-12') {
  const json = z.toJSONSchema(schema, target ? { target } : {}) as JsonSchema;
  return generateFromSchema(json, new TextPool(prompt));
}

describe('generateFromSchema', () => {
  it('fills a notes-like object with prompt sentences, schema-valid', () => {
    const schema = z.object({
      title: z.string(),
      sections: z
        .array(
          z.object({
            heading: z.string().max(40),
            bullets: z.array(z.string().min(5)).min(1).max(5),
          }),
        )
        .min(1),
      actionItems: z.array(z.object({ owner: z.string().nullable(), task: z.string() })),
    });
    const value = schema.parse(fill(schema));
    expect(value.sections.length).toBeGreaterThan(0);
    const strings = JSON.stringify(value);
    expect(strings).toContain('We agreed to ship the beta on Friday.');
    expect(strings).not.toContain('clean notes'); // system prompt is not quoted
    expect(value.title.split(' ').length).toBeLessThanOrEqual(6);
  });

  it('is deterministic', () => {
    const schema = z.object({ a: z.array(z.string()), b: z.enum(['x', 'y', 'z']), c: z.number() });
    expect(fill(schema)).toEqual(fill(schema));
  });

  it.each(['draft-7', 'draft-2020-12'] as const)(
    'satisfies a broad set of constraints (%s)',
    (target) => {
      const schema = z.object({
        literal: z.literal('fixed'),
        kind: z.enum(['decision', 'question', 'todo']),
        maybe: z.string().optional(),
        nullable: z.number().nullable(),
        union: z.union([z.object({ a: z.string() }), z.number()]),
        count: z.number().int().min(3).max(9),
        positive: z.number().positive(),
        ratio: z.number().gt(0).lt(1),
        stepped: z.number().int().multipleOf(5).min(12),
        flag: z.boolean(),
        short: z.string().min(3).max(8),
        long: z.string().min(200),
        email: z.email(),
        url: z.url(),
        uuid: z.uuid(),
        at: z.iso.datetime(),
        day: z.iso.date(),
        tags: z.array(z.string()).length(2),
        tuple: z.tuple([z.string(), z.number()]),
        record: z.record(z.string(), z.number()),
        intersection: z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
        nothing: z.null(),
      });
      expect(() => schema.parse(fill(schema, target))).not.toThrow();
    },
  );

  it.each(['draft-7', 'draft-2020-12'] as const)(
    'generates required keys that only exist via additionalProperties (%s)',
    (target) => {
      const schema = z.object({
        sections: z.record(z.enum(['decisions', 'risks', 'next_steps']), z.string()),
        partial: z.partialRecord(z.enum(['a', 'b']), z.number()),
      });
      const value = schema.parse(fill(schema, target));
      expect(Object.keys(value.sections).sort()).toEqual(['decisions', 'next_steps', 'risks']);
    },
  );

  it('names padded keys from propertyNames and honours additionalProperties: false', () => {
    const pool = new TextPool(prompt);
    expect(
      generateFromSchema(
        {
          type: 'object',
          propertyNames: { enum: ['x', 'y'] },
          additionalProperties: { type: 'string' },
          minProperties: 2,
        },
        pool,
      ),
    ).toEqual({ x: expect.any(String), y: expect.any(String) });
    expect(
      generateFromSchema({ type: 'object', minProperties: 1, additionalProperties: true }, pool),
    ).toHaveProperty('key1');
    expect(() =>
      generateFromSchema({ type: 'object', required: ['a'], additionalProperties: false }, pool),
    ).toThrow(UnsupportedSchemaError);
  });

  it('picks clean multipleOf values', () => {
    const pool = new TextPool(prompt);
    expect(generateFromSchema({ type: 'number', multipleOf: 10, maximum: 5 }, pool)).toBe(0);
    expect(generateFromSchema({ type: 'number', multipleOf: 0.1, minimum: 0.25 }, pool)).toBe(0.3);
    expect(generateFromSchema({ type: 'integer', multipleOf: 4, maximum: -3 }, pool)).toBe(-4);
    const int = z.number().int().multipleOf(5);
    expect(fill(int)).toBe(0);
  });

  it('terminates on recursive schemas', () => {
    interface Node {
      label: string;
      children: Node[];
    }
    const node: z.ZodType<Node> = z.object({
      label: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const schema = z.object({ root: node });
    expect(() => schema.parse(fill(schema))).not.toThrow();
  });

  it('falls back to a fixed sentence when the prompt has no text', () => {
    const value = generateFromSchema(
      { type: 'string' },
      new TextPool([{ role: 'user', content: '' }]),
    );
    expect(value).toBe('This is a mock response from @oat/mocks.');
  });

  it('rejects schemas it cannot satisfy', () => {
    expect(() => generateFromSchema(false, new TextPool([]))).toThrow(UnsupportedSchemaError);
    expect(() => generateFromSchema({ $ref: 'http://x/y' }, new TextPool([]))).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => generateFromSchema({ $ref: '#/$defs/missing' }, new TextPool([]))).toThrow(
      UnsupportedSchemaError,
    );
  });
});
