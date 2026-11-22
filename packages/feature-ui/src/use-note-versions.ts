'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { isApiError } from './chat-client';
import type { DocumentDetail } from '@oat/services/dto/api-types';
import type { EnhancementVersionList, RestoreTarget } from '@oat/services/dto/enhance';

import { useEnhanceClient } from './enhance-client';

/** What is about to replace the note body. */
export type ReplaceKind = 'regenerate' | 'undo' | 'redo' | 'restore';

/** A replace waiting for the user's OK (D-20). `unchecked`: the edit check couldn't run (fail safe). */
export type PendingReplace = { kind: ReplaceKind; unchecked: boolean; run: () => void };

/**
 * One toast slot per note for enhance / undo / restore messages: a newer one replaces the older, so an "Undo"
 * from an earlier state never lingers over a newer note.
 */
export const noteToastId = (documentId: string) => `note-versions-${documentId}`;

/**
 * Versions of a meeting note's enhanced body (4.5, D-20), editors only: the list (versions + saved edited
 * notes), restoring a version, a saved note or the notes a run started from, and "undo enhancement" with a
 * redo. Every replace goes through {@link guard}: pending edits are saved, the server says whether the body is
 * stored anywhere, and if not (or the check fails) the user confirms first. The server also keeps the replaced
 * body as a snapshot, so nothing is lost either way. Restores are body writes on the editor's current version
 * (409 if the note changed elsewhere).
 */
export function useNoteVersions({
  documentId,
  enabled,
  settle,
  currentVersion,
  onRestored,
  prepareApply,
}: {
  documentId: string;
  /** Live meeting notes the user can edit. */
  enabled: boolean;
  /** Saves pending edits; `false` if they couldn't be saved. */
  settle: () => Promise<boolean>;
  /** The note version the editor is at. */
  currentVersion: () => number;
  /** The server wrote a new body: show it and continue from its version. */
  onRestored: (document: DocumentDetail) => void | Promise<void>;
  prepareApply?: () => (document: DocumentDetail) => Promise<void>;
}) {
  const enhanceClient = useEnhanceClient();
  const [list, setList] = useState<EnhancementVersionList | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<PendingReplace | null>(null);
  const restored = useRef(onRestored);
  useEffect(() => {
    restored.current = onRestored;
  });
  const toastId = noteToastId(documentId);

  const refresh = useCallback(async (): Promise<EnhancementVersionList | null> => {
    try {
      const next = await enhanceClient.versions(documentId);
      setList(next);
      return next;
    } catch {
      return null;
    }
  }, [documentId, enhanceClient]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    enhanceClient.versions(documentId).then(
      (next) => !cancelled && setList(next),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, documentId, enhanceClient]);

  /**
   * Runs `action` (something that replaces the body) right away if the body is stored somewhere, else after
   * the user confirms. Unsaved edits: the action runs and refuses by itself (it saves first too).
   */
  const guard = useCallback(
    async (kind: ReplaceKind, action: () => void) => {
      // An "Undo"/"Redo" offered for an earlier state must not linger over this one.
      toast.dismiss(toastId);
      setChecking(true);
      try {
        if (!(await settle())) return action();
        const fresh = await refresh();
        if (fresh && !fresh.body.edited) return action();
        setPending({ kind, unchecked: !fresh, run: action });
      } catch (error) {
        toast.error('Your latest edits aren’t saved yet', {
          id: toastId,
          description: error instanceof Error ? error.message : 'Try again once they are saved.',
        });
      } finally {
        setChecking(false);
      }
    },
    [refresh, settle, toastId],
  );

  const confirmPending = useCallback(() => {
    setPending(null);
    pending?.run();
  }, [pending]);
  const cancelPending = useCallback(() => setPending(null), []);

  /** Sets the body to a version / saved note (`output`) or a run's starting notes. Errors are toasted. */
  const restore = useCallback(
    async (id: string, target: RestoreTarget): Promise<boolean> => {
      setRestoring(true);
      try {
        if (!(await settle()))
          throw new Error('Your latest edits aren’t saved yet. Wait for “Saved”, then try again.');
        const apply = prepareApply?.() ?? restored.current;
        const { document, snapshot } = await enhanceClient.restore(id, {
          baseVersion: currentVersion(),
          target,
        });
        await apply(document);
        void refresh();
        if (snapshot) setList((l) => l && { ...l, snapshots: [snapshot, ...l.snapshots] });
        return true;
      } catch (error) {
        if (isApiError(error, 'stale_version')) {
          toast.error('This note changed elsewhere', {
            id: toastId,
            description: 'Reload to see the latest version, then try again.',
          });
        } else {
          toast.error('Couldn’t restore', {
            id: toastId,
            description: error instanceof Error ? error.message : 'Try again in a moment.',
          });
        }
        return false;
      } finally {
        setRestoring(false);
      }
    },
    [currentVersion, refresh, settle, toastId, enhanceClient, prepareApply],
  );

  /** Redo: the newest run's output again (guarded). */
  const redo = useCallback(
    (enhancementId: string) =>
      void guard('redo', async () => {
        if (await restore(enhancementId, 'output')) {
          toast.success('Enhancement restored', { id: toastId });
        }
      }),
    [guard, restore, toastId],
  );

  /** Back to the notes I had before the newest enhancement (guarded), with a "Redo" in the toast. */
  const undo = useCallback(
    () =>
      void guard('undo', async () => {
        // Fresh: the newest run may have finished after the list was loaded.
        const latest = (await refresh())?.versions[0];
        if (!latest || !(await restore(latest.id, 'notes'))) return;
        toast('Enhancement undone', {
          id: toastId,
          description: 'Your own notes are back. The enhanced version stays in Note history.',
          action: { label: 'Redo', onClick: () => redo(latest.id) },
        });
      }),
    [guard, redo, refresh, restore, toastId],
  );

  return {
    list,
    refresh,
    guard,
    restore,
    undo,
    restoring,
    checking,
    settle,
    pending,
    confirmPending,
    cancelPending,
    toastId,
  };
}

export type NoteVersions = ReturnType<typeof useNoteVersions>;
