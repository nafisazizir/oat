/**
 * Browser/renderer auth client (framework-free). Safe to import from client components: it pulls in no
 * server code (no DB, no SMTP).
 */
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient, organizationClient } from 'better-auth/client/plugins';

import { ac, roles } from './access.ts';

export { GOOGLE_PROVIDER_ID } from './providers.ts';

/** `baseURL` is the app origin; omit it in the browser (same origin). The API is at `/api/auth`. */
export function createOatAuthClient(baseURL?: string) {
  return createAuthClient({
    ...(baseURL ? { baseURL } : {}),
    basePath: '/api/auth',
    plugins: [magicLinkClient(), organizationClient({ ac, roles })],
  });
}

export type OatAuthClient = ReturnType<typeof createOatAuthClient>;
