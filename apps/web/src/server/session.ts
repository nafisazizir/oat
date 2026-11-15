import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { getAuth } from './auth';

export type Session = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>
>;

/**
 * The current session (user + session row) from the request cookies (or a bearer token), or `null`.
 * Validated against the database; deduped per request.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  // Read the request headers first: that marks the route dynamic before anything touches env or the DB
  // (so `next build` never tries to prerender a signed-in page).
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

/**
 * The current session, or a redirect to `/sign-in`. Every signed-in layout, page loader and server
 * action calls this; `src/proxy.ts` only does a cheap cookie-presence redirect in front of it.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  return session;
}
