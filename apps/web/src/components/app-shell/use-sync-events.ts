'use client';

import type { SyncEvent } from '@oat/core/sync';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { DOCUMENT_CHANGED_EVENT, type DocumentChangedDetail } from '@/lib/api-client';

/** Window event re-broadcasting every sync change (`detail: SyncEvent`) for components that care. */
export const SYNC_CHANGE_EVENT = 'oat:sync-change';

/** Tables whose changes reshape the sidebar even without a readable document id. */
const TREE_TABLES = new Set(['folder', 'workspace', 'membership']);
/** A save this tab made itself is echoed back by the server; ignore the echo for this long. */
const OWN_ECHO_MS = 5_000;
const DEBOUNCE_MS = 800;
/**
 * No refresh until the page has settled after a load: a `router.refresh()` while the initial RSC stream is
 * still hydrating can leave duplicated DOM behind (seen in e2e right after a reload).
 */
const SETTLE_MS = 3_000;
const SAVED_KEY = 'oat:sync-saved-here';

/** This tab's recent saves survive a reload (the server's echo of a save can arrive just after one). */
function loadSavedHere(now: number): Map<string, number> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? '{}') as Record<string, number>;
    return new Map(Object.entries(raw).filter(([, at]) => now - at < OWN_ECHO_MS));
  } catch {
    return new Map();
  }
}

function storeSavedHere(saved: Map<string, number>): void {
  try {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify(Object.fromEntries(saved)));
  } catch {
    // private mode / storage blocked: only this page load remembers
  }
}

/**
 * Whether a sync event should re-render the server components (sidebar tree, current page). Pure:
 * `savedHere` maps document ids this tab saved itself to when.
 */
export function shouldRefresh(event: SyncEvent, savedHere: Map<string, number>, now: number) {
  if (event.workspaces) return true;
  if (event.tables.some((t) => TREE_TABLES.has(t))) return true;
  return event.ids.some((id) => now - (savedHere.get(id) ?? -Infinity) > OWN_ECHO_MS);
}

/**
 * Live updates for the web app (3.5): listens to `GET /api/sync/events` (SSE; the browser reconnects
 * with `Last-Event-ID`) and refreshes the server-rendered tree and page when another tab or device
 * changed something this user can read — debounced, skipped for this tab's own saves, and deferred while
 * the tab is hidden (its stream is closed then, and resumes from the last event id). Every event is also re-dispatched as {@link SYNC_CHANGE_EVENT}.
 */
export function useSyncEvents(): void {
  const router = useRouter();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const mountedAt = Date.now();
    const savedHere = loadSavedHere(mountedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;

    const refresh = () => {
      clearTimeout(timer);
      const wait = Math.max(DEBOUNCE_MS, mountedAt + SETTLE_MS - Date.now());
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden') return; // done when the tab is shown again
        dirty = false;
        router.refresh();
      }, wait);
    };
    const onLocalSave = (e: Event) => {
      const now = Date.now();
      savedHere.set((e as CustomEvent<DocumentChangedDetail>).detail.id, now);
      for (const [id, at] of savedHere) if (now - at > OWN_ECHO_MS) savedHere.delete(id);
      storeSavedHere(savedHere);
    };
    // The stream is open only while the tab is visible (review 3.5: a hidden tab costs the server
    // nothing); on reopen it resumes from the last event id, so nothing is missed.
    let source: EventSource | null = null;
    let lastEventId: string | null = null;
    const onChange = (message: Event) => {
      const m = message as MessageEvent<string>;
      if (m.lastEventId) lastEventId = m.lastEventId;
      let event: SyncEvent;
      try {
        event = JSON.parse(m.data) as SyncEvent;
      } catch {
        return;
      }
      window.dispatchEvent(new CustomEvent<SyncEvent>(SYNC_CHANGE_EVENT, { detail: event }));
      if (!shouldRefresh(event, savedHere, Date.now())) return;
      dirty = true;
      refresh();
    };
    const connect = () => {
      if (source) return;
      const url = lastEventId
        ? `/api/sync/events?lastEventId=${encodeURIComponent(lastEventId)}`
        : '/api/sync/events';
      const s = new EventSource(url);
      source = s;
      // `<html data-sync-live>` while connected (e2e waits for it before changing things elsewhere).
      s.addEventListener('ready', (m) => {
        if ((m as MessageEvent).lastEventId) lastEventId = (m as MessageEvent).lastEventId;
        document.documentElement.dataset.syncLive = '';
      });
      s.addEventListener('error', () => delete document.documentElement.dataset.syncLive);
      s.addEventListener('change', onChange);
    };
    const disconnect = () => {
      source?.close();
      source = null;
      delete document.documentElement.dataset.syncLive;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        connect();
        if (dirty) refresh();
      } else {
        disconnect();
      }
    };
    if (document.visibilityState !== 'hidden') connect();
    window.addEventListener(DOCUMENT_CHANGED_EVENT, onLocalSave);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disconnect();
      clearTimeout(timer);
      window.removeEventListener(DOCUMENT_CHANGED_EVENT, onLocalSave);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);
}
