'use client';

import type { JSONContent } from '@oat/editor';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  announceDocumentChange,
  DOCUMENT_CHANGED_EVENT,
  type DocumentChangedDetail,
  documentsApi,
  isApiError,
} from '@/lib/api-client';
import type { DocumentDetail } from '@/lib/api-types';
import { canRebase } from '@/lib/json-equal';

/** Wait this long after the last keystroke… */
export const SAVE_DEBOUNCE_MS = 400;
/** …but never longer than this after the first unsaved change (task 3.3: autosave ≤ 1 s). */
export const SAVE_MAX_WAIT_MS = 1000;
/** Retry delay after a network or server error. */
const RETRY_MS = 4000;
/** Consecutive 409s we re-send on top of the server copy before giving up (see `canRebase`). */
const MAX_REBASES = 3;
/** `fetch(…, { keepalive })` bodies are capped at 64 KB by browsers. */
const KEEPALIVE_LIMIT = 60_000;

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

type Patch = { title?: string; contentJson?: JSONContent };
type Snapshot = { title: string; contentJson: JSONContent };

/** Puts a failed patch back in front of anything typed since (newer values win). */
function keepUnsaved(pending: { current: Patch | null }, failed: Patch) {
  pending.current = { ...failed, ...pending.current };
}

/**
 * Debounced autosave with optimistic concurrency (D-19). Changes are merged into one pending patch and
 * sent as `PATCH /api/documents/:id` with the version this editor last saw as `baseVersion`; one request
 * at a time, newer edits queue behind it.
 *
 * On a 409 the server copy is compared with what this editor last saved (`base`): if nobody touched the
 * fields this patch writes (e.g. the page was only renamed from the sidebar while the body was edited),
 * the patch is re-sent on the new version. Otherwise saving stops and the state becomes `conflict` (the
 * page offers a reload; 3.5 adds conflicted copies). Network/server errors keep the edits and retry while
 * the editor is open; leaving the page flushes what's pending once.
 */
export function useAutosave({
  id,
  version,
  initial,
  enabled,
  onSaved,
  onExternalChange,
}: {
  id: string;
  version: number;
  /** The document as loaded (the base the first patch is made on). */
  initial: Snapshot;
  enabled: boolean;
  onSaved?: (doc: DocumentDetail, patch: Patch) => void;
  /** Same-tab change from elsewhere in the app (e.g. a sidebar rename) — already applied server-side. */
  onExternalChange?: (change: DocumentChangedDetail) => void;
}) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(version);
  const base = useRef<Snapshot>(initial);
  const pending = useRef<Patch | null>(null);
  const inFlight = useRef(false);
  const rebases = useRef(0);
  const firstDirtyAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopped = useRef(false);
  const unmounted = useRef(false);
  const callbacks = useRef({ onSaved, onExternalChange });
  useEffect(() => {
    callbacks.current = { onSaved, onExternalChange };
  });

  /** `flush` itself, for retries and follow-up saves scheduled from inside it. */
  const again = useRef<() => Promise<void>>(async () => {});
  const flush = useCallback(
    async (options: { keepalive?: boolean } = {}) => {
      clearTimeout(timer.current);
      if (inFlight.current || stopped.current || !pending.current) return;
      const patch = pending.current;
      pending.current = null;
      firstDirtyAt.current = null;
      inFlight.current = true;
      setState('saving');
      const body = { baseVersion: versionRef.current, ...patch };
      const keepalive = options.keepalive && JSON.stringify(body).length < KEEPALIVE_LIMIT;
      /** Send what's pending right away (edits typed meanwhile, or a rebased patch). */
      let sendNext = false;
      try {
        const doc = await documentsApi.update(id, body, keepalive ? { keepalive: true } : {});
        versionRef.current = doc.version;
        base.current = { title: doc.title, contentJson: doc.contentJson };
        rebases.current = 0;
        setError(null);
        // Keeps the sidebar's copy of the version current (renames from there send it).
        announceDocumentChange(doc);
        callbacks.current.onSaved?.(doc, patch);
        if (pending.current) sendNext = true;
        else setState('saved');
      } catch (err) {
        keepUnsaved(pending, patch);
        const server = isApiError(err, 'stale_version') ? err.body?.document : undefined;
        if (server && rebases.current < MAX_REBASES && canRebase(patch, base.current, server)) {
          rebases.current += 1;
          versionRef.current = server.version;
          base.current = { title: server.title, contentJson: server.contentJson };
          sendNext = true;
        } else if (isApiError(err, 'stale_version')) {
          stopped.current = true;
          setState('conflict');
        } else {
          // Keep the edits and retry transient failures while the editor is open.
          setState('error');
          setError(err instanceof Error ? err.message : 'Couldn’t save.');
          const transient = isApiError(err, 'network') || (isApiError(err) && err.status >= 500);
          if (transient && !unmounted.current) {
            timer.current = setTimeout(() => void again.current(), RETRY_MS);
          }
        }
      } finally {
        inFlight.current = false;
      }
      if (sendNext) void again.current();
    },
    [id],
  );

  useEffect(() => {
    again.current = flush;
  }, [flush]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const now = Date.now();
    firstDirtyAt.current ??= now;
    const wait = Math.max(
      0,
      Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - (now - firstDirtyAt.current)),
    );
    timer.current = setTimeout(() => void flush(), wait);
  }, [flush]);

  /** Records a change (title and/or content) to be saved soon. */
  const queue = useCallback(
    (patch: Patch) => {
      if (!enabled || stopped.current) return;
      pending.current = { ...pending.current, ...patch };
      setState('pending');
      if (!inFlight.current) schedule();
    },
    [enabled, schedule],
  );

  // Same-tab changes made elsewhere (sidebar rename/move, restore): adopt their version.
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<DocumentChangedDetail>).detail;
      if (detail.id !== id || detail.version <= versionRef.current) return;
      versionRef.current = detail.version;
      base.current = { ...base.current, title: detail.title };
      callbacks.current.onExternalChange?.(detail);
    };
    window.addEventListener(DOCUMENT_CHANGED_EVENT, listener);
    return () => window.removeEventListener(DOCUMENT_CHANGED_EVENT, listener);
  }, [id]);

  // Leaving: warn while something is unsaved; flush when the tab is hidden or the editor unmounts.
  useEffect(() => {
    unmounted.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      // Includes edits kept after a conflict, unless the user chose Reload (`discard`).
      if (pending.current || inFlight.current) event.preventDefault();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush({ keepalive: true });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden);
      // One last best-effort save; no timed retries once the editor is gone.
      void flush({ keepalive: true });
      unmounted.current = true;
      clearTimeout(timer.current);
    };
  }, [flush]);

  const retry = useCallback(() => void flush(), [flush]);

  /** Drops unsaved edits and stops saving (the user chose to reload the server copy). */
  const discard = useCallback(() => {
    stopped.current = true;
    pending.current = null;
    clearTimeout(timer.current);
  }, []);

  /**
   * Saves everything pending and waits until nothing is in flight (before a server-side write such as
   * enhancing). `false` if edits are still unsaved after a few attempts or saving stopped (conflict).
   */
  const settle = useCallback(async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (stopped.current) return false;
      if (!pending.current && !inFlight.current) return true;
      if (!inFlight.current) {
        await flush();
        if (pending.current && !inFlight.current) return false; // the save failed; edits kept
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return false;
  }, [flush]);

  /** Takes over a version the server wrote itself (e.g. the enhanced body), as the base for later saves. */
  const adopt = useCallback((doc: { version: number; contentJson: JSONContent }) => {
    if (doc.version <= versionRef.current) return;
    versionRef.current = doc.version;
    base.current = { ...base.current, contentJson: doc.contentJson };
  }, []);

  return { state, error, queue, retry, flush, discard, settle, adopt };
}
