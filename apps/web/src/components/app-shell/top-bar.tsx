'use client';

import { Kbd } from '@oat/ui/components/kbd';
import { SidebarTrigger } from '@oat/ui/components/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { NewNoteButton } from './new-note-button';

const ActionsContext = createContext<HTMLDivElement | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <ActionsContext value={container}>
      <header
        data-testid="top-bar"
        className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background-100 px-3"
      >
        <Tooltip>
          <TooltipTrigger render={<SidebarTrigger data-testid="sidebar-trigger" />} />
          <TooltipContent>
            Toggle sidebar <Kbd>⌘B</Kbd>
          </TooltipContent>
        </Tooltip>
        <div className="ms-auto flex min-w-0 items-center gap-2">
          <NewNoteButton variant="outline" size="sm" className="rounded-full" />
          <div
            ref={setContainer}
            data-testid="top-bar-actions"
            className="flex min-w-0 items-center gap-2"
          />
        </div>
      </header>
      {children}
    </ActionsContext>
  );
}

export function TopBarActions({ children }: { children: ReactNode }) {
  const container = useContext(ActionsContext);
  return container ? createPortal(children, container) : null;
}
