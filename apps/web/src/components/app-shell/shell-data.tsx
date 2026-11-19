'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ShellData } from '@/lib/tree';

import { applyTreeOps, type TreeOp } from './optimistic-tree';

type Pending = { key: number; op: TreeOp; confirmedFor: ShellData | null };

type OptimisticTree = {
  /** Shows `op` right away; returns a handle to confirm or roll it back. */
  apply(op: TreeOp): { confirm(): void; rollback(): void };
};

const ShellDataContext = createContext<ShellData | null>(null);
const OptimisticTreeContext = createContext<OptimisticTree | null>(null);

/**
 * Makes the server-loaded shell data (`getShellData()`) available to the client shell, with pending
 * sidebar mutations (create, rename, move, trash…) applied on top. A confirmed op is kept until the
 * server data it was confirmed against has been replaced (the `router.refresh()` that follows every
 * mutation), so rows never jump back between the response and the refresh.
 */
export function ShellDataProvider({
  value,
  children,
}: {
  value: ShellData;
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const nextKey = useRef(0);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  // Server data changed: drop the ops that were confirmed against an older copy.
  const live = pending.filter((p) => p.confirmedFor === null || p.confirmedFor === value);
  if (live.length !== pending.length) setPending(live);

  const apply = useCallback((op: TreeOp) => {
    const key = nextKey.current++;
    setPending((prev) => [...prev, { key, op, confirmedFor: null }]);
    return {
      confirm: () =>
        setPending((prev) =>
          prev.map((p) => (p.key === key ? { ...p, confirmedFor: latest.current } : p)),
        ),
      rollback: () => setPending((prev) => prev.filter((p) => p.key !== key)),
    };
  }, []);

  const data = useMemo(
    () =>
      applyTreeOps(
        value,
        pending.filter((p) => p.confirmedFor === null || p.confirmedFor === value).map((p) => p.op),
      ),
    [value, pending],
  );
  const tree = useMemo(() => ({ apply }), [apply]);

  return (
    <OptimisticTreeContext.Provider value={tree}>
      <ShellDataContext.Provider value={data}>{children}</ShellDataContext.Provider>
    </OptimisticTreeContext.Provider>
  );
}

export function useShellData(): ShellData {
  const context = useContext(ShellDataContext);
  if (!context) throw new Error('useShellData must be used within a ShellDataProvider.');
  return context;
}

export function useOptimisticTree(): OptimisticTree {
  const context = useContext(OptimisticTreeContext);
  if (!context) throw new Error('useOptimisticTree must be used within a ShellDataProvider.');
  return context;
}
