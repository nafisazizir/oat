import {
  combineTransactionSteps,
  Extension,
  findChildrenInRange,
  getChangedRanges,
} from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

import { BLOCK_TYPES, isOrigin, type Origin } from './blocks.ts';

/** Transactions carrying this meta keep `origin: 'ai'` on emptied blocks (e.g. programmatic loads). */
export const KEEP_ORIGIN_META = 'oat:keepOrigin';

const originPluginKey = new PluginKey('oatOrigin');

/**
 * Positions (in the final doc) where a replace step merged two textblocks of different origin:
 * Backspace/Delete at a block boundary, or deleting a selection that spans blocks.
 */
function mixedOriginJoins(transactions: readonly Transaction[]): number[] {
  const joins: number[] = [];
  for (const tr of transactions) {
    for (let k = 0; k < joins.length; k++) joins[k] = tr.mapping.map(joins[k]!);
    tr.steps.forEach((step, i) => {
      if (!(step instanceof ReplaceStep) || step.from >= step.to) return;
      const doc = tr.docs[i]!;
      const $from = doc.resolve(step.from);
      const $to = doc.resolve(step.to);
      if ($from.sameParent($to) || !$from.parent.isTextblock || !$to.parent.isTextblock) return;
      if ($from.parent.attrs.origin === $to.parent.attrs.origin) return;
      joins.push(tr.mapping.slice(i).map(step.from));
    });
  }
  return joins;
}

/**
 * `origin: 'me' | 'ai'` on every block node (D-20), rendered as `data-origin` so styles.css can
 * colour AI-added text with `--ai-text` and my text with `--my-text`.
 *
 * Editing rules, so that what I type never looks AI-written:
 * - a block split off with Enter starts as `me` (`keepOnSplit: false`);
 * - an `ai` block whose text the user empties becomes `me` (anything typed into it next is mine);
 * - joining two blocks of different origin (Backspace/Delete at the boundary, deleting a selection
 *   across blocks) yields `me` — never relabel my words as AI (D-23).
 * Editing the words of an AI block in place keeps it `ai`; finer provenance is out of scope (4.4).
 * The origin changes are part of the same undo step as the edit that caused them.
 */
export const OriginAttribute = Extension.create({
  name: 'origin',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_TYPES],
        attributes: {
          origin: {
            default: 'me' satisfies Origin,
            keepOnSplit: false,
            parseHTML: (element) => {
              const value = element.getAttribute('data-origin');
              return isOrigin(value) ? value : 'me';
            },
            renderHTML: (attributes) => ({
              'data-origin': isOrigin(attributes.origin) ? attributes.origin : 'me',
            }),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const types: ReadonlySet<string> = new Set(BLOCK_TYPES);
    return [
      new Plugin({
        key: originPluginKey,
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta(KEEP_ORIGIN_META))) return null;
          const transform = combineTransactionSteps(oldState.doc, [...transactions]);
          const { tr } = newState;

          // Rule 3 (D-23): joining two textblocks of different origin yields `me`.
          for (const pos of mixedOriginJoins(transactions)) {
            const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
            for (let depth = $pos.depth; depth > 0; depth--) {
              const node = $pos.node(depth);
              if (!node.isTextblock) continue;
              if (node.attrs.origin === 'ai') {
                tr.setNodeMarkup($pos.before(depth), undefined, { ...node.attrs, origin: 'me' });
              }
              break;
            }
          }

          // Rule 2: an AI block whose text was emptied is mine.
          for (const { newRange } of getChangedRanges(transform)) {
            const emptiedAi = findChildrenInRange(
              newState.doc,
              newRange,
              (node) =>
                types.has(node.type.name) &&
                node.attrs.origin === 'ai' &&
                !node.isLeaf &&
                node.textContent.length === 0,
            );
            for (const { node, pos } of emptiedAi) {
              if (tr.doc.nodeAt(pos)?.attrs.origin !== 'ai') continue;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, origin: 'me' });
            }
          }
          if (!tr.steps.length) return null;
          tr.setStoredMarks(newState.storedMarks);
          // Recorded in history with the edit that caused it, so undo restores the old origins too.
          return tr;
        },
      }),
    ];
  },
});
