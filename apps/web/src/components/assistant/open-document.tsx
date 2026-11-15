'use client';

import type { JSONContent } from '@oat/editor';
import type { OatEditorProps } from '@oat/editor/react';
import { createContext, useContext, useEffect, useRef } from 'react';

export type NoteEditor = Parameters<NonNullable<OatEditorProps['onReady']>>[0];

/**
 * The bridge between the document page's editor and the assistant panel next to it (6.4). The editor
 * registers what only it can do (save pending edits, take over a server-written version); the panel uses it
 * around approving a proposal on the open note, so the editor never keeps a stale copy that would conflict on
 * its next autosave, and nothing the user types is lost.
 */
export type OpenDocumentHandle = {
  /** Saves pending edits; `false` when edits are still unsaved (failed / conflict). */
  settle(): Promise<boolean>;
  /** Takes over a version the server wrote (an approved assistant edit) as the base for later saves. */
  adopt(doc: { version: number; contentJson: JSONContent }): void;
  /** Shows a whole server-written body (fallback when the changed blocks can't be patched in place). */
  replace(doc: { version: number; contentJson: JSONContent }): void;
  /** The live TipTap editor, once mounted. */
  editor(): NoteEditor | null;
};

export type OpenDocumentBridge = {
  documentId: string;
  register(handle: OpenDocumentHandle | null): void;
  handle(): OpenDocumentHandle | null;
  /** Scrolls the note to a block and highlights it. */
  showBlock(blockId: string): void;
};

export const OpenDocumentContext = createContext<OpenDocumentBridge | null>(null);

export const useOpenDocument = () => useContext(OpenDocumentContext);

/**
 * Called by the document editor (one call in `DocumentEditor`): makes its handle available to the assistant
 * for this document. No-op outside the assistant-enabled document page.
 */
export function useRegisterOpenDocument(documentId: string, handle: OpenDocumentHandle) {
  const bridge = useContext(OpenDocumentContext);
  const latest = useRef(handle);
  useEffect(() => {
    latest.current = handle;
  });
  useEffect(() => {
    if (!bridge || bridge.documentId !== documentId) return;
    bridge.register({
      settle: () => latest.current.settle(),
      adopt: (doc) => latest.current.adopt(doc),
      replace: (doc) => latest.current.replace(doc),
      editor: () => latest.current.editor(),
    });
    return () => bridge.register(null);
  }, [bridge, documentId]);
}

/**
 * Applies a server-written version to the open editor by replacing only the blocks a proposal changed, in one
 * transaction (the rest of the note, the selection and undo history stay as they are). The transaction doesn't
 * emit an update: the editor now equals the version the caller just adopted, so there is nothing to save.
 * `false` when a changed block can't be found here (the caller falls back to `replace`).
 */
export function applyServerBlocks(
  editor: NoteEditor,
  serverDoc: JSONContent,
  blockIds: readonly string[],
): boolean {
  const wanted = new Set(blockIds);
  const server = new Map<string, JSONContent>();
  const visit = (node: JSONContent) => {
    const id = node.attrs?.id;
    if (typeof id === 'string' && wanted.has(id) && !server.has(id)) {
      server.set(id, node);
      return;
    }
    node.content?.forEach(visit);
  };
  visit(serverDoc);
  if (server.size !== wanted.size) return false;

  const targets: { id: string; pos: number; size: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    const id = node.attrs.id as unknown;
    if (typeof id === 'string' && server.has(id) && !targets.some((t) => t.id === id)) {
      targets.push({ id, pos, size: node.nodeSize });
      return false;
    }
    return true;
  });
  if (targets.length !== server.size) return false;

  try {
    const tr = editor.state.tr;
    for (const target of targets.sort((a, b) => b.pos - a.pos)) {
      tr.replaceWith(
        target.pos,
        target.pos + target.size,
        editor.schema.nodeFromJSON(server.get(target.id)!),
      );
    }
    tr.setMeta('preventUpdate', true);
    editor.view.dispatch(tr);
    return true;
  } catch {
    return false;
  }
}
