import { getSessionCookie } from '@oat/auth/cookies';
import { createRateLimiter, type RateLimiter } from '@oat/auth/rate-limit';
import { type NextRequest, NextResponse } from 'next/server';

import { signInPath } from '@/lib/redirect';
import { guardShareRequest, trustProxyHeadersFromEnv } from '@/lib/share-guard';

/** Where invitation links land: the URL carries the invite's secret token. */
export const INVITE_PATH_PREFIX = '/invite/';

/** Response headers for invite pages (5.1 review): the token never leaves in a Referer, never cached. */
export const INVITE_HEADERS: Readonly<Record<string, string>> = {
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Where share links land (5.3): the URL carries the document's share token. */
export const SHARE_PATH_PREFIX = '/share/';

let shareLimiter: RateLimiter | undefined;

/**
 * Runs on the Node.js runtime for:
 * - `/share/*` (public share viewer, 5.3): never needs a session. Rate limit, strict CSP and privacy
 *   headers, cookies stripped (`src/lib/share-guard.ts`).
 * - `/invite/*`: public (signed-out visitors see them); only gets its headers here.
 * - The signed-in app: optimistic gate, no session cookie → `/sign-in?next=<path>`. It only checks that a
 *   cookie is present (no DB); `(app)/layout.tsx` (`requireSession`) does the real check, so an expired
 *   or forged cookie still ends at sign-in.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith(SHARE_PATH_PREFIX)) {
    shareLimiter ??= createRateLimiter(process.env.REDIS_URL || undefined);
    return guardShareRequest(request, shareLimiter, {
      dev: process.env.NODE_ENV === 'development',
      trustProxyHeaders: trustProxyHeadersFromEnv(process.env),
    });
  }
  if (pathname.startsWith(INVITE_PATH_PREFIX)) {
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(INVITE_HEADERS)) response.headers.set(name, value);
    return response;
  }
  if (getSessionCookie(request)) return NextResponse.next();
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.url));
}

export const config = {
  // The `(app)` route group (keep in sync with `src/app/(app)/*`), plus the public invite and share pages
  // for their headers.
  matcher: [
    '/home',
    '/d/:path*',
    '/settings/:path*',
    '/templates/:path*',
    '/invite/:path*',
    '/share/:path*',
  ],
};
