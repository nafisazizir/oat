import type { TextPool } from './text.ts';

/**
 * Generates a deterministic value that satisfies a JSON Schema, with strings drawn from the prompt (`TextPool`),
 * so `response_format: json_schema` requests get schema-valid, relevant-looking output.
 *
 * Supported: `type` (incl. type arrays), `properties`/`required`, `additionalProperties`/`minProperties`,
 * `items`/`prefixItems` (and draft-7 tuple `items`), `minItems`/`maxItems`, `enum`, `const`, `anyOf`/`oneOf`
 * (first non-null branch), `allOf` (merged), `$ref` into `$defs`/`definitions`, `propertyNames` `enum`/`const` (record keys), string `minLength`/`maxLength`/
 * `format` (date-time, date, time, email, uri/url, uuid), number `minimum`/`maximum`/exclusive bounds/
 * `multipleOf`. Not supported: `pattern`, `not`, `if/then/else`, `uniqueItems` for non-string items,
 * `dependentRequired`. That covers what zod's `toJSONSchema` emits for the schemas we use.
 */
export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema;
  minProperties?: number;
  items?: JsonSchema | JsonSchema[];
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  minLength?: number;
  maxLength?: number;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  propertyNames?: JsonSchema;
  [key: string]: unknown;
}

/** Arrays get this many items unless min/maxItems say otherwise. */
const DEFAULT_ITEMS = 3;
/** Past this nesting depth, optional properties are skipped and arrays use `minItems`, so recursion ends. */
const MAX_DEPTH = 6;
const TITLE_KEY =
  /(^|_)(title|name|heading|label|subject|topic)$|(Title|Name|Heading|Label|Subject|Topic)$/;

interface Ctx {
  root: JsonSchema;
  pool: TextPool;
}

export class UnsupportedSchemaError extends Error {}

export function generateFromSchema(schema: JsonSchema, pool: TextPool): unknown {
  return gen(schema, { root: schema, pool }, '', 0);
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new UnsupportedSchemaError(`unsupported $ref "${ref}"`);
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    node =
      node !== null && typeof node === 'object'
        ? (node as Record<string, unknown>)[key]
        : undefined;
  }
  if (node === undefined) throw new UnsupportedSchemaError(`unresolvable $ref "${ref}"`);
  return node as JsonSchema;
}

function isNullSchema(s: JsonSchema): boolean {
  return typeof s === 'object' && (s.type === 'null' || (s.const === null && s.type === undefined));
}

function mergeAll(schemas: JsonSchema[], ctx: Ctx): JsonSchemaObject {
  const out: JsonSchemaObject = {};
  for (let s of schemas) {
    if (typeof s === 'boolean') continue;
    if (s.$ref) s = resolveRef(ctx.root, s.$ref);
    if (typeof s === 'boolean') continue;
    const { properties, required, ...rest } = s;
    Object.assign(out, rest);
    if (properties) out.properties = { ...out.properties, ...properties };
    if (required) out.required = [...(out.required ?? []), ...required];
  }
  return out;
}

function gen(schema: JsonSchema, ctx: Ctx, key: string, depth: number): unknown {
  if (schema === false) throw new UnsupportedSchemaError(`schema at "${key}" accepts nothing`);
  if (schema === true) return ctx.pool.sentence();
  if (depth > MAX_DEPTH * 4) throw new UnsupportedSchemaError('schema recursion too deep');

  if (schema.$ref !== undefined) {
    const { $ref, ...siblings } = schema;
    const target = resolveRef(ctx.root, $ref);
    const merged = Object.keys(siblings).length > 0 ? mergeAll([target, siblings], ctx) : target;
    return gen(merged, ctx, key, depth + 1);
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[ctx.pool.tick() % schema.enum.length];
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const { allOf, ...rest } = schema;
    return gen(mergeAll([rest, ...allOf], ctx), ctx, key, depth);
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    const { anyOf: _a, oneOf: _o, ...rest } = schema;
    // Deep in a recursive schema, prefer `null` when allowed so generation terminates.
    const nullBranch = branches.find(isNullSchema);
    if (depth > MAX_DEPTH && nullBranch !== undefined) return null;
    const branch = branches.find((b) => !isNullSchema(b)) ?? branches[0]!;
    const merged = Object.keys(rest).length > 0 ? mergeAll([rest, branch], ctx) : branch;
    return gen(merged, ctx, key, depth + 1);
  }

  const type = pickType(schema);
  switch (type) {
    case 'object':
      return genObject(schema, ctx, depth);
    case 'array':
      return genArray(schema, ctx, key, depth);
    case 'string':
      return genString(schema, ctx, key);
    case 'number':
    case 'integer':
      return genNumber(schema, type === 'integer');
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      throw new UnsupportedSchemaError(`unsupported type "${String(type)}"`);
  }
}

function pickType(s: JsonSchemaObject): string {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') ?? 'null';
  if (typeof s.type === 'string') return s.type;
  if (s.properties || s.additionalProperties !== undefined) return 'object';
  if (s.items !== undefined || s.prefixItems) return 'array';
  if (s.minimum !== undefined || s.maximum !== undefined) return 'number';
  return 'string';
}

function genObject(s: JsonSchemaObject, ctx: Ctx, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required = s.required ?? [];
  const deep = depth > MAX_DEPTH;
  for (const [prop, propSchema] of Object.entries(s.properties ?? {})) {
    if (deep && !required.includes(prop)) continue;
    out[prop] = gen(propSchema, ctx, prop, depth + 1);
  }

  const extra = s.additionalProperties;
  const addKey = (name: string) => {
    if (extra === false) {
      throw new UnsupportedSchemaError(
        `key "${name}" is not allowed (additionalProperties: false)`,
      );
    }
    out[name] = gen(extra ?? true, ctx, name, depth + 1);
  };
  // Required keys outside `properties` (e.g. `z.record(z.enum([...]), …)`) take the additionalProperties schema.
  for (const name of required) if (!Object.hasOwn(out, name)) addKey(name);
  // Otherwise records only get keys when minProperties demands some, named from propertyNames when it lists them.
  const names = propertyNameCandidates(s.propertyNames);
  for (let i = 1; Object.keys(out).length < (s.minProperties ?? 0);) {
    if (names) {
      const next = names.find((n) => !Object.hasOwn(out, n));
      if (next === undefined)
        throw new UnsupportedSchemaError('minProperties exceeds propertyNames');
      addKey(next);
    } else {
      while (Object.hasOwn(out, `key${i}`)) i++;
      addKey(`key${i}`);
    }
  }
  return out;
}

/** Key names allowed by a `propertyNames` schema with `enum`/`const`; `undefined` when unconstrained. */
function propertyNameCandidates(schema: JsonSchema | undefined): string[] | undefined {
  if (schema === undefined || typeof schema === 'boolean') return undefined;
  if (typeof schema.const === 'string') return [schema.const];
  if (Array.isArray(schema.enum))
    return schema.enum.filter((v): v is string => typeof v === 'string');
  return undefined;
}

function genArray(s: JsonSchemaObject, ctx: Ctx, key: string, depth: number): unknown[] {
  const prefix = s.prefixItems ?? (Array.isArray(s.items) ? s.items : []);
  const rest = Array.isArray(s.items) ? (s.additionalItems as JsonSchema | undefined) : s.items;
  const min = s.minItems ?? 0;
  const max = s.maxItems ?? Number.POSITIVE_INFINITY;
  // Tuples: exactly the prefix (more only if minItems demands and extra items are allowed).
  const count =
    prefix.length > 0
      ? Math.max(Math.min(prefix.length, max), rest === undefined || rest === false ? 0 : min)
      : depth > MAX_DEPTH
        ? min
        : Math.min(Math.max(min, DEFAULT_ITEMS), max);
  if (rest === false && count > prefix.length) {
    throw new UnsupportedSchemaError('minItems exceeds the tuple length');
  }
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    out.push(gen(prefix[i] ?? rest ?? true, ctx, key, depth + 1));
  }
  return out;
}

const FORMATS: Record<string, (n: number) => string> = {
  'date-time': () => '2026-01-01T09:00:00.000Z',
  date: () => '2026-01-01',
  time: () => '09:00:00',
  email: (n) => `person${n}@example.com`,
  uri: (n) => `https://example.com/mock/${n}`,
  url: (n) => `https://example.com/mock/${n}`,
  uuid: (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
};

function genString(s: JsonSchemaObject, ctx: Ctx, key: string): string {
  const format = s.format !== undefined ? FORMATS[s.format] : undefined;
  let value = format
    ? format(ctx.pool.tick() + 1)
    : TITLE_KEY.test(key)
      ? ctx.pool.title()
      : ctx.pool.sentence();
  const min = s.minLength ?? 0;
  while (value.length < min) value = `${value} ${ctx.pool.sentence()}`.trim();
  if (s.maxLength !== undefined && value.length > s.maxLength)
    value = value.slice(0, s.maxLength).trimEnd();
  // Trimming may undercut minLength again (min ≤ max ≤ trimmed length + whitespace): pad with dots.
  if (value.length < min) value = value.padEnd(min, '.');
  return value;
}

function genNumber(s: JsonSchemaObject, integer: boolean): number {
  let lo = s.minimum ?? Number.NEGATIVE_INFINITY;
  let hi = s.maximum ?? Number.POSITIVE_INFINITY;
  // Draft-4 boolean form: exclusiveMinimum: true modifies `minimum`.
  const exMin =
    typeof s.exclusiveMinimum === 'number'
      ? s.exclusiveMinimum
      : s.exclusiveMinimum
        ? lo
        : undefined;
  const exMax =
    typeof s.exclusiveMaximum === 'number'
      ? s.exclusiveMaximum
      : s.exclusiveMaximum
        ? hi
        : undefined;
  const span = Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 2;
  const step = integer ? 1 : Math.min(1, span / 4 || 1);
  if (exMin !== undefined) lo = Math.max(lo, exMin + step);
  if (exMax !== undefined) hi = Math.min(hi, exMax - step);

  let value: number;
  if (Number.isFinite(lo) && Number.isFinite(hi)) value = lo + (hi - lo) / 2;
  else if (Number.isFinite(lo)) value = Math.max(lo, 1);
  else if (Number.isFinite(hi)) value = Math.min(hi, 1);
  else value = 1;

  if (integer)
    value = Math.min(
      Math.ceil(value),
      Number.isFinite(hi) ? Math.floor(hi) : Number.POSITIVE_INFINITY,
    );
  if (s.multipleOf !== undefined && s.multipleOf > 0) {
    const m = s.multipleOf;
    // 0 when it is in range, else the multiple closest to the range edge nearest 0.
    const k =
      lo <= 0 && hi >= 0 ? 0 : lo > 0 ? Math.ceil(lo / m - 1e-9) : Math.floor(hi / m + 1e-9);
    value = Number((k * m).toPrecision(12)) + 0; // trims float noise (0.1 * 3); `+ 0` turns -0 into 0
    if (value > hi || value < lo) {
      throw new UnsupportedSchemaError('no multipleOf value fits the bounds');
    }
  }
  return value;
}
