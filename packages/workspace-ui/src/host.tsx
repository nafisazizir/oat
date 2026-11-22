'use client';

import type { OatClient } from '@oat/client';
import { createContext, useContext, type ComponentType, type ComponentProps } from 'react';
import type { AppRoute } from './routes';

export type WorkspaceHost = {
  platform: 'web' | 'desktop';
  appOrigin: string;
  client: OatClient;
  route: AppRoute;
  navigate(route: AppRoute, options?: { replace?: boolean }): void;
  hrefOf(route: AppRoute): string;
  Link: ComponentType<{ route: AppRoute } & Omit<ComponentProps<'a'>, 'href'>>;
  refresh(): void;
  online: boolean;
  switchWorkspace?(workspaceId: string): Promise<void>;
  exportNotes?(workspaceId: string): Promise<number | null>;
  workspaceExitBlockedReason?: string;
};

export const WorkspaceHost = createContext<WorkspaceHost | null>(null);

export function useWorkspaceHost(): WorkspaceHost {
  const host = useContext(WorkspaceHost);
  if (!host) throw new Error('useWorkspaceHost must be used within WorkspaceHost.');
  return host;
}
