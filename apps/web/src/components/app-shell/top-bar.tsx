'use client';

import { ShellHeader } from '@oat/workspace-ui';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ActionsContext = createContext<HTMLDivElement | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <ActionsContext value={container}>
      <ShellHeader data-testid="top-bar">
        <div className="ms-auto flex min-w-0 items-center gap-2">
          <div
            ref={setContainer}
            data-testid="top-bar-actions"
            className="flex min-w-0 items-center gap-2 overflow-x-auto"
          />
        </div>
      </ShellHeader>
      {children}
    </ActionsContext>
  );
}

export function TopBarActions({ children }: { children: ReactNode }) {
  const container = useContext(ActionsContext);
  return container ? createPortal(children, container) : null;
}
