/**
 * Request-body validation for the Notion mock, modelled on the limits Notion documents for the public API
 * (version 2022-06-28): block types and their shapes, ≤ 2000 characters per rich-text `text.content` and link
 * URL, ≤ 100 rich-text objects per array, ≤ 100 blocks per `children` array, at most two levels of nesting
 * below the request's top-level blocks, ≤ 1000 block elements and ≤ 500 KB per request. A failure is a
 * message in Notion's style (`body.children[3].paragraph.rich_text[0].text.content.length should be ≤ 2000,
 * instead was 2001.`) that the caller turns into a 400 `validation_error`. The messages are ours.
 */

export const LIMITS = {
  textContent: 2000,
  linkUrl: 2000,
  richTextItems: 100,
  children: 100,
  /** Levels of nesting allowed below a request's top-level blocks. */
  nesting: 2,
  blocksPerRequest: 1000,
  bodyBytes: 500_000,
  pageSize: 100,
} as const;

export const COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
const ALL_COLORS = new Set<string>([...COLORS, ...COLORS.slice(1).map((c) => `${c}_background`)]);

/** The `code.language` values Notion accepts. */
export const CODE_LANGUAGES = new Set([
  'abap',
  'agda',
  'arduino',
  'assembly',
  'bash',
  'basic',
  'bnf',
  'c',
  'c#',
  'c++',
  'clojure',
  'coffeescript',
  'coq',
  'css',
  'dart',
  'dhall',
  'diff',
  'docker',
  'ebnf',
  'elixir',
  'elm',
  'erlang',
  'f#',
  'flow',
  'fortran',
  'gherkin',
  'glsl',
  'go',
  'graphql',
  'groovy',
  'haskell',
  'hcl',
  'html',
  'idris',
  'java',
  'javascript',
  'json',
  'julia',
  'kotlin',
  'latex',
  'less',
  'lisp',
  'livescript',
  'llvm ir',
  'lua',
  'makefile',
  'markdown',
  'markup',
  'matlab',
  'mathematica',
  'mermaid',
  'nix',
  'notion formula',
  'objective-c',
  'ocaml',
  'pascal',
  'perl',
  'php',
  'plain text',
  'powershell',
  'prolog',
  'protobuf',
  'purescript',
  'python',
  'r',
  'racket',
  'reason',
  'ruby',
  'rust',
  'sass',
  'scala',
  'scheme',
  'scss',
  'shell',
  'smalltalk',
  'solidity',
  'sql',
  'swift',
  'toml',
  'typescript',
  'vb.net',
  'verilog',
  'vhdl',
  'visual basic',
  'webassembly',
  'xml',
  'yaml',
  'java/c/c++/c#',
]);

/** Block types the mock accepts on create/append, and whether they may carry `children`. */
const BLOCK_TYPES: Record<string, { richText: boolean; children: boolean }> = {
  paragraph: { richText: true, children: true },
  heading_1: { richText: true, children: false },
  heading_2: { richText: true, children: false },
  heading_3: { richText: true, children: false },
  bulleted_list_item: { richText: true, children: true },
  numbered_list_item: { richText: true, children: true },
  to_do: { richText: true, children: true },
  toggle: { richText: true, children: true },
  quote: { richText: true, children: true },
  callout: { richText: true, children: true },
  code: { richText: true, children: false },
  divider: { richText: false, children: false },
};
export const WRITABLE_BLOCK_TYPES = Object.keys(BLOCK_TYPES);

const ANNOTATIONS = new Set(['bold', 'italic', 'strikethrough', 'underline', 'code', 'color']);

export class ValidationError extends Error {
  override name = 'ValidationError';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(message: string): never {
  throw new ValidationError(message);
}

const describe = (v: unknown) =>
  v === undefined ? 'undefined' : typeof v === 'string' ? `"${v.slice(0, 40)}"` : JSON.stringify(v);

/** A link URL Notion accepts: an absolute web/mail/phone URL of at most 2000 characters (no `javascript:`). */
export function isValidUrl(value: string): boolean {
  if (value.length > LIMITS.linkUrl) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function validateRichText(value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(`${path} should be an array, instead was ${describe(value)}.`);
  if (value.length > LIMITS.richTextItems) {
    fail(`${path}.length should be ≤ ${LIMITS.richTextItems}, instead was ${value.length}.`);
  }
  value.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(item)) fail(`${at} should be an object, instead was ${describe(item)}.`);
    const type = item.type ?? 'text';
    if (type !== 'text') fail(`${at}.type should be "text" (the mock only accepts text).`);
    const text = item.text;
    if (!isObject(text)) fail(`${at}.text should be defined, instead was ${describe(text)}.`);
    if (typeof text.content !== 'string') {
      fail(`${at}.text.content should be a string, instead was ${describe(text.content)}.`);
    }
    if (text.content.length > LIMITS.textContent) {
      fail(
        `${at}.text.content.length should be ≤ ${LIMITS.textContent}, instead was ${text.content.length}.`,
      );
    }
    if (text.link !== undefined && text.link !== null) {
      if (!isObject(text.link) || typeof text.link.url !== 'string') {
        fail(`${at}.text.link.url should be a string.`);
      }
      if (!isValidUrl(text.link.url)) fail(`Invalid URL for link: ${at}.text.link.url.`);
    }
    if (item.annotations !== undefined) {
      if (!isObject(item.annotations)) fail(`${at}.annotations should be an object.`);
      for (const [key, v] of Object.entries(item.annotations)) {
        if (!ANNOTATIONS.has(key)) fail(`${at}.annotations.${key} is not a valid annotation.`);
        if (key === 'color' ? !ALL_COLORS.has(String(v)) : typeof v !== 'boolean') {
          fail(`${at}.annotations.${key} has an invalid value ${describe(v)}.`);
        }
      }
    }
  });
}

/** Total block elements in a children array, nested ones included. */
export function countBlocks(children: readonly unknown[]): number {
  let n = 0;
  for (const child of children) {
    n += 1;
    if (isObject(child)) {
      const type = blockType(child);
      const data = type ? child[type] : undefined;
      if (isObject(data) && Array.isArray(data.children)) n += countBlocks(data.children);
    }
  }
  return n;
}

/** The block's type: `type` when given, else its single known type key. */
export function blockType(block: Record<string, unknown>): string | undefined {
  if (typeof block.type === 'string') return block.type;
  return Object.keys(block).find((key) => key in BLOCK_TYPES);
}

/**
 * Validates a `children` array of block objects. `level` is the nesting level of these blocks below the
 * request's top-level list (0 = top level).
 */
export function validateChildren(value: unknown, path: string, level = 0): void {
  if (!Array.isArray(value)) fail(`${path} should be an array, instead was ${describe(value)}.`);
  if (value.length > LIMITS.children) {
    fail(`${path}.length should be ≤ ${LIMITS.children}, instead was ${value.length}.`);
  }
  if (level > LIMITS.nesting) {
    fail(
      `${path}: blocks can be nested at most ${LIMITS.nesting} levels deep in one request; ` +
        'append deeper children in a follow-up request.',
    );
  }
  value.forEach((block, i) => validateBlock(block, `${path}[${i}]`, level));
}

function validateBlock(block: unknown, path: string, level: number): void {
  if (!isObject(block)) fail(`${path} should be an object, instead was ${describe(block)}.`);
  if (block.object !== undefined && block.object !== 'block') {
    fail(`${path}.object should be "block", instead was ${describe(block.object)}.`);
  }
  const type = blockType(block);
  if (!type || !(type in BLOCK_TYPES)) {
    fail(
      `${path}.type should be one of ${WRITABLE_BLOCK_TYPES.join(', ')}, instead was ${describe(type)}.`,
    );
  }
  const spec = BLOCK_TYPES[type]!;
  const data = block[type];
  if (!isObject(data)) fail(`${path}.${type} should be defined, instead was ${describe(data)}.`);
  const at = `${path}.${type}`;
  if (spec.richText) validateRichText(data.rich_text, `${at}.rich_text`);
  if (data.color !== undefined && !ALL_COLORS.has(String(data.color))) {
    fail(`${at}.color has an invalid value ${describe(data.color)}.`);
  }
  if (type === 'to_do' && data.checked !== undefined && typeof data.checked !== 'boolean') {
    fail(`${at}.checked should be a boolean, instead was ${describe(data.checked)}.`);
  }
  if (type === 'code') {
    if (typeof data.language !== 'string' || !CODE_LANGUAGES.has(data.language)) {
      fail(
        `${at}.language should be a supported language, instead was ${describe(data.language)}.`,
      );
    }
    if (data.caption !== undefined) validateRichText(data.caption, `${at}.caption`);
  }
  if (type === 'callout' && data.icon !== undefined && data.icon !== null) {
    validateIcon(data.icon, `${at}.icon`);
  }
  if (type.startsWith('heading_') && data.is_toggleable !== undefined) {
    if (typeof data.is_toggleable !== 'boolean') fail(`${at}.is_toggleable should be a boolean.`);
  }
  if (data.children !== undefined) {
    const toggleableHeading = type.startsWith('heading_') && data.is_toggleable === true;
    if (!spec.children && !toggleableHeading) {
      fail(`${at}.children: ${type} blocks can't have children.`);
    }
    validateChildren(data.children, `${at}.children`, level + 1);
  }
}

export function validateIcon(icon: unknown, path: string): void {
  if (!isObject(icon)) fail(`${path} should be an object.`);
  if (icon.type === 'emoji') {
    if (typeof icon.emoji !== 'string' || icon.emoji.length === 0 || icon.emoji.length > 16) {
      fail(`${path}.emoji should be a single emoji.`);
    }
  } else if (icon.type === 'external') {
    if (!isObject(icon.external) || typeof icon.external.url !== 'string') {
      fail(`${path}.external.url should be a string.`);
    }
    if (!isValidUrl(icon.external.url)) fail(`${path}.external.url is not a valid URL.`);
  } else {
    fail(`${path}.type should be "emoji" or "external", instead was ${describe(icon.type)}.`);
  }
}

/** Database property types the mock can store page values for. */
export type PropertyType =
  | 'title'
  | 'rich_text'
  | 'date'
  | 'url'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'people'
  | 'email';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Validates one property value against its schema type. */
export function validatePropertyValue(type: PropertyType, value: unknown, path: string): void {
  if (!isObject(value)) fail(`${path} should be an object, instead was ${describe(value)}.`);
  const v = value[type];
  switch (type) {
    case 'title':
    case 'rich_text':
      return validateRichText(v, `${path}.${type}`);
    case 'date': {
      if (v === null) return;
      if (!isObject(v) || typeof v.start !== 'string' || !ISO_DATE.test(v.start)) {
        fail(`${path}.date.start should be an ISO 8601 date, instead was ${describe(v)}.`);
      }
      if (v.end !== undefined && v.end !== null) {
        if (typeof v.end !== 'string' || !ISO_DATE.test(v.end)) {
          fail(`${path}.date.end should be an ISO 8601 date.`);
        }
      }
      return;
    }
    case 'url':
    case 'email':
      if (v === null) return;
      if (typeof v !== 'string') fail(`${path}.${type} should be a string or null.`);
      if (type === 'url' && v.length > LIMITS.linkUrl) {
        fail(`${path}.url.length should be ≤ ${LIMITS.linkUrl}, instead was ${v.length}.`);
      }
      return;
    case 'number':
      if (v !== null && typeof v !== 'number') fail(`${path}.number should be a number or null.`);
      return;
    case 'checkbox':
      if (typeof v !== 'boolean') fail(`${path}.checkbox should be a boolean.`);
      return;
    case 'select':
      if (v !== null && (!isObject(v) || typeof v.name !== 'string')) {
        fail(`${path}.select should be { name } or null.`);
      }
      return;
    case 'multi_select':
      if (!Array.isArray(v) || v.some((o) => !isObject(o) || typeof o.name !== 'string')) {
        fail(`${path}.multi_select should be an array of { name }.`);
      }
      return;
    case 'people':
      if (!Array.isArray(v) || v.some((o) => !isObject(o) || typeof o.id !== 'string')) {
        fail(`${path}.people should be an array of user objects with an id.`);
      }
      return;
  }
}
