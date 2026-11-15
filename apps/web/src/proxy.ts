import { getSessionCookie } from '@oat/auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

import { signInPath } from '@/lib/redirect';

/**
 * Optimistic gate for the signed-in app: no session cookie → `/sign-in?next=<path>`. It only checks
 * that a cookie is present (no DB); `(app)/layout.tsx` (`requireSession`) does the real check, so an
 * expired or forged cookie still ends at sign-in.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(signInPath(`${pathname}${search}`), request.url));
}

export const config = {
  // The `(app)` route group. Keep in sync with `src/app/(app)/*`.
  matcher: ['/home', '/d/:path*', '/settings', '/templates'],
};
