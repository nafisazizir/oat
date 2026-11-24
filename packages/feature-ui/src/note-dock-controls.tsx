'use client';

import { createContext, useContext } from 'react';

export const DockControlsContext = createContext<{
  transcript: (element: HTMLDivElement | null) => void;
  assistant: (element: HTMLDivElement | null) => void;
} | null>(null);

export function DockControlsOutlet({ panel }: { panel: 'transcript' | 'assistant' }) {
  const outlets = useContext(DockControlsContext);
  if (!outlets) return null;
  return <div ref={outlets[panel]} className="shrink-0 empty:hidden" />;
}
