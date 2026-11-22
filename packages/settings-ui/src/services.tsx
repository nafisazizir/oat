'use client';

import { OatApiError, type OatClient } from '@oat/client';
import { createContext, useContext, type ReactNode } from 'react';

export interface SettingsServices {
  client: OatClient;
  workspaceId: string;
  recordingActive?: boolean;
  exportNotes: (id: string) => Promise<number | null>;
  connect: (provider: 'notion' | 'google-calendar', workspaceId: string) => Promise<void>;
  onProfileChanged?: () => void;
  onWorkspaceChanged?: () => void;
  onWorkspaceExited: () => void;
}

type Context = SettingsServices & { refresh: () => Promise<void> };
const Context = createContext<Context | null>(null);

export function SettingsProvider({ value, children }: { value: Context; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSettings() {
  const value = useContext(Context);
  if (!value) throw new Error('SettingsProvider is missing.');
  return value;
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof OatApiError && error.status === 0) {
    return 'You’re offline or the server can’t be reached.';
  }
  return error instanceof Error ? error.message : fallback;
}

export function useWorkspaceAction() {
  const { refresh } = useSettings();
  return async (action: () => Promise<unknown>, reload = true) => {
    try {
      await action();
      if (reload) await refresh();
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, error: errorMessage(error, 'Couldn’t save that change.') } as const;
    }
  };
}
