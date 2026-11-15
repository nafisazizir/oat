'use client';

import { createContext, useContext } from 'react';

import type { ShellData } from '@/lib/tree';

const ShellDataContext = createContext<ShellData | null>(null);

/** Makes the server-loaded shell data (`getShellData()`) available to the client shell. */
export function ShellDataProvider({
  value,
  children,
}: {
  value: ShellData;
  children: React.ReactNode;
}) {
  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}

export function useShellData(): ShellData {
  const context = useContext(ShellDataContext);
  if (!context) throw new Error('useShellData must be used within a ShellDataProvider.');
  return context;
}
