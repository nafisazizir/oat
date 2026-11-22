import { OatApiError, type OatTransport } from '@oat/client';
import { useSyncExternalStore } from 'react';
import { call } from '../bridge';

let online = true;
const listeners = new Set<() => void>();
function update(next: boolean) {
  if (online === next) return;
  online = next;
  for (const listener of listeners) listener();
}

export function observeApi(transport: OatTransport): OatTransport {
  return async (request) => {
    try {
      const response = await transport(request);
      update(response.status !== 0);
      if (
        response.status >= 200 &&
        response.status < 300 &&
        request.method !== 'GET' &&
        request.path.startsWith('/api/workspaces')
      ) {
        // Sync membership before changing the local target used by recording:start.
        await call('sync:now').catch(() => undefined);
        if (
          request.path === '/api/workspaces/active' ||
          (request.path === '/api/workspaces' && request.method === 'POST')
        ) {
          const body = (await response.json()) as { workspaceId?: string };
          if (body.workspaceId)
            await call('workspaces:set-active', { workspaceId: body.workspaceId });
        }
      }
      return response;
    } catch (error) {
      if (error instanceof OatApiError) update(error.status !== 0);
      throw error;
    }
  };
}

export function useApiOnline() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => online,
  );
}
