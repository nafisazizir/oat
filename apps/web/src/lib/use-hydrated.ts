import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/**
 * False during the server render and hydration, true once React has hydrated on the client. Controls whose
 * behaviour is client-only (fetch-on-click buttons, `preventDefault` forms) stay disabled until then: a click
 * before hydration would otherwise do nothing, or submit the form natively (a GET with the fields in the
 * URL). On a busy machine `next dev` can take seconds to hydrate, which made e2e clicks land on dead
 * buttons (ci-flakes).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
