import { getSessionCookie } from '@oat/auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

import { signInPath } from '@/lib/redirect';

/** Where invitation links land: the URL carries the invite's secret token. */
export const INVITE_PATH_PREFIX = '/invite/';

/** Response headers for invite pages (5.1 review): the token never leaves in a Referer, never cached. */
export const INVITE_HEADERS: Readonly<Record<string, string>> = {
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * Optimistic gate for the signed-in app: no session cookie → `/sign-in?next=<path>`. It only checks
 * that a cookie is present (no DB); `(app)/layout.tsx` (`requireSession`) does the real check, so an
 * expired or forged cookie still ends at sign-in. Invite pages are public (signed-out visitors see
 * them) and only get their headers here.
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith(INVITE_PATH_PREFIX)) {
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(INVITE_HEADERS)) response.headers.set(name, value);
    return response;
  }
  if (getSessionCookie(request)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.url));
}

export const config = {
  // The `(app)` route group (keep in sync with `src/app/(app)/*`), plus invite pages for their headers.
  matcher: ['/home', '/d/:path*', '/settings/:path*', '/templates', '/invite/:path*'],
};
