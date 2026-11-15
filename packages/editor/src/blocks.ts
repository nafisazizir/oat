/**
 * Block node types that carry a stable `id` (citations, enhancement diffing) and an `origin`
 * (who wrote it: me or the AI). Inline nodes (text, mention, hard break) and `doc` don't.
 */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'callout',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

const blockTypeSet: ReadonlySet<string> = new Set(BLOCK_TYPES);

export function isBlockType(type: string | undefined): type is BlockType {
  return type !== undefined && blockTypeSet.has(type);
}

/** Who wrote a block. `me` is the default; enhancement (4.4) sets `ai` on blocks it adds (D-20). */
export const ORIGINS = ['me', 'ai'] as const;
export type Origin = (typeof ORIGINS)[number];

export function isOrigin(value: unknown): value is Origin {
  return value === 'me' || value === 'ai';
}

/** A random block id. `crypto.randomUUID` needs a secure context; fall back to getRandomValues. */
export function generateBlockId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
