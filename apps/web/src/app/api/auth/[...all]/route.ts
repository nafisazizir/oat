import { isBlockedAuthPath } from '@oat/auth/magic-link';

import { getAuth } from '@/server/auth';

/** Better Auth API (`/api/auth/*`): magic link, OAuth callbacks, session, organizations, sign-out. */
async function handler(request: Request): Promise<Response> {
  // Better Auth's own `GET /magic-link/verify` would let a cross-site link sign a visitor into someone
  // else's account (login CSRF). Magic links go through `/sign-in/confirm` + the same-origin POST
  // `/api/sign-in/magic-link`, which calls `getAuth().handler` in-process and isn't affected by this.
  if (isBlockedAuthPath(new URL(request.url).pathname)) {
    return new Response('Not found', { status: 404 });
  }
  return getAuth().handler(request);
}

export { handler as GET, handler as POST };
