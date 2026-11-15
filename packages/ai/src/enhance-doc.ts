/**
 * Reconciled enhancement output → the TipTap document that becomes the note body (D-20). Every block node
 * carries `origin` (D-23 styling); `me` blocks reuse the user's own inline content (marks, links, mentions) and
 * task checkbox, so nothing they wrote changes. Each section is an `h2`; empty sections are left out.
 *
 * Citations: an `ai` block's `sources` (transcript refs like `s12`) are resolved to segment ids and returned
 * per block id, for the enhancement record (`citations`), not stored in the document.
 */
import { generateBlockId, type JSONContent, validateDoc } from '@oat/editor';

import type { EnhanceBlock, EnhanceOutput, ListItemBlock } from './enhance.ts';
import type { NoteLine } from './enhance-origin.ts';

export interface EnhancementToDocOptions {
  /** The note line behind each `me` block (`Reconciled.sourceLine`). Without it, `me` blocks use their text. */
  sourceLine?: WeakMap<EnhanceBlock, NoteLine>;
  /** Transcript ref → segment id (`segmentIdForRef`); unknown refs are dropped. */
  resolveRef?: (ref: string) => string | undefined;
  /** Block id generator (tests). Default `generateBlockId`. */
  generateId?: () => string;
}

export interface EnhancedDoc {
  doc: JSONContent;
  /** Block id → cited transcript segment ids (only blocks with at least one valid citation). */
  citations: Record<string, string[]>;
}

function taskSuffix(block: EnhanceBlock): string {
  if (block.kind !== 'task' || block.origin !== 'ai') return '';
  const parts = [block.owner, block.due && `due ${block.due}`].filter(Boolean);
  return parts.length ? ` — ${parts.join(', ')}` : '';
}

/** Single-line plain text (models sometimes add newlines). */
const plain = (text: string) => text.replace(/\s+/g, ' ').trim();

export function enhancementToDoc(
  output: EnhanceOutput,
  options: EnhancementToDocOptions = {},
): EnhancedDoc {
  const newId = options.generateId ?? generateBlockId;
  const citations: Record<string, string[]> = {};

  const inline = (block: EnhanceBlock): JSONContent[] => {
    const line = block.origin === 'me' ? options.sourceLine?.get(block) : undefined;
    if (line?.content.length) return structuredClone(line.content);
    const text = plain(block.text) + taskSuffix(block);
    return text ? [{ type: 'text', text }] : [];
  };

  const cite = (id: string, block: EnhanceBlock) => {
    if (block.origin !== 'ai' || !block.sources?.length || !options.resolveRef) return;
    const ids = [
      ...new Set(block.sources.map((r) => options.resolveRef!(r.trim())).filter(Boolean)),
    ] as string[];
    if (ids.length) citations[id] = ids;
  };

  const paragraph = (block: EnhanceBlock, topLevel = false): JSONContent => {
    // A code block of mine stays a code block, line breaks and all.
    const code = block.origin === 'me' ? options.sourceLine?.get(block)?.code : undefined;
    if (topLevel && code !== undefined) {
      return {
        type: 'codeBlock',
        attrs: { id: newId(), origin: 'me' },
        content: [{ type: 'text', text: code }],
      };
    }
    const content = inline(block);
    return {
      type: 'paragraph',
      attrs: { id: newId(), origin: block.origin },
      ...(content.length ? { content } : {}),
    };
  };

  const listItem = (block: ListItemBlock): JSONContent => {
    const id = newId();
    cite(id, block);
    const line = block.origin === 'me' ? options.sourceLine?.get(block) : undefined;
    const isTask = block.kind === 'task';
    return {
      type: isTask ? 'taskItem' : 'listItem',
      attrs: {
        id,
        origin: block.origin,
        ...(isTask ? { checked: line?.checked === true } : {}),
      },
      content: [paragraph(block), ...lists(block.children ?? [])],
    };
  };

  /** Consecutive bullets → one bulletList, consecutive tasks → one taskList. */
  function lists(items: readonly ListItemBlock[]): JSONContent[] {
    const out: JSONContent[] = [];
    for (const item of items) {
      const type = item.kind === 'task' ? 'taskList' : 'bulletList';
      const prev = out.at(-1);
      if (prev?.type === type) prev.content!.push(listItem(item));
      else out.push({ type, attrs: { id: newId(), origin: 'ai' }, content: [listItem(item)] });
    }
    // A list is `me` when any item in it is mine (never mute my words; items carry their own origin anyway).
    for (const list of out) {
      if (list.content!.some((i) => i.attrs?.origin === 'me')) list.attrs!.origin = 'me';
    }
    return out;
  }

  const content: JSONContent[] = [];
  for (const section of output.sections) {
    if (!section.blocks.length) continue;
    const heading = plain(section.heading);
    content.push({
      type: 'heading',
      attrs: { id: newId(), origin: 'ai', level: 2 },
      ...(heading ? { content: [{ type: 'text', text: heading }] } : {}),
    });
    let run: ListItemBlock[] = [];
    const flush = () => {
      if (run.length) content.push(...lists(run));
      run = [];
    };
    for (const block of section.blocks) {
      if (block.kind === 'paragraph') {
        flush();
        const node = paragraph(block, true);
        cite(node.attrs!.id as string, block);
        content.push(node);
      } else {
        run.push(block);
      }
    }
    flush();
  }
  const doc: JSONContent = {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph', attrs: { id: newId() } }],
  };
  const valid = validateDoc(doc);
  if (!valid.ok) throw new Error(`enhancement produced an invalid document: ${valid.error}`);
  return { doc, citations };
}
