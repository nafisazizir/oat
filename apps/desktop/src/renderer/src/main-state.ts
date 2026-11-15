/**
 * Renderer side of the main-owned store: one client per window, `useMainState()` for components.
 *
 * It subscribes to `state:changed` **before** asking for the snapshot, and keeps whichever has the
 * higher `seq`, so neither a push that overtakes the `state:get` reply nor a stale reply can roll the
 * window back.
 */
import type { MainState, MainStateSnapshot, OatBridge } from '@oat/core/bridge';
import { useSyncExternalStore } from 'react';

import { bridge } from './bridge.ts';

export interface MainStateClient {
  getSnapshot(): MainStateSnapshot | null;
  subscribe(listener: () => void): () => void;
  /** Resolves once the first snapshot has arrived. */
  ready: Promise<void>;
  dispose(): void;
}

export function createMainStateClient(
  oat: Pick<OatBridge, 'invoke' | 'subscribe'>,
): MainStateClient {
  let current: MainStateSnapshot | null = null;
  const listeners = new Set<() => void>();

  const apply = (next: MainStateSnapshot) => {
    if (current && next.seq <= current.seq) return;
    current = next;
    for (const listener of listeners) listener();
  };

  const unsubscribe = oat.subscribe('state:changed', apply);
  const ready = oat.invoke('state:get').then((result) => {
    if (result.ok) apply(result.value);
    else throw new Error(`state:get failed: ${result.error.message}`);
  });

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
    dispose: unsubscribe,
  };
}

let shared: MainStateClient | null = null;

function client(): MainStateClient {
  shared ??= createMainStateClient(bridge());
  return shared;
}

/** The current main state, or `null` until the first snapshot arrives (a few ms after mount). */
export function useMainState(): MainState | null {
  const c = client();
  const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
  return snapshot?.state ?? null;
}

/** The sequence number of what this window shows (for debugging and tests). */
export function useMainStateSeq(): number | null {
  const c = client();
  return useSyncExternalStore(c.subscribe, c.getSnapshot)?.seq ?? null;
}
