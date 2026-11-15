/**
 * Request guard for the public share viewer (`/share/[token]`, 5.3), run from `src/proxy.ts`:
 * - rate limits (fixed window, Redis when `REDIS_URL` is set) per client IP and per share token → 429
 *   with `Retry-After`. Which IP: see {@link clientIp} / `TRUST_PROXY_HEADERS`;
 * - a strict, per-request nonce CSP (Next.js applies the nonce to its own scripts; the root layout's
 *   inline theme script is allowed by hash) plus `no-referrer` (the token is in the URL), `noindex`,
 *   no framing, `no-store`;
 * - the viewer's cookies and `Authorization` header are stripped before the page runs, so the public
 *   page can't depend on (or leak anything tied to) a session.
 */
import { createHash } from 'node:crypto';

import type { RateLimiter } from '@oat/auth/rate-limit';
import { type NextRequest, NextResponse } from 'next/server';

import { themeScript } from './theme';

/** Requests per client IP per window. Generous for people, tight enough to make scraping slow. */
export const SHARE_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

/**
 * Requests per share token per window, whatever the IP: caps a single link being hammered from many
 * (or spoofed) addresses. Malformed tokens share one bucket.
 */
export const SHARE_TOKEN_RATE_LIMIT = { limit: 600, windowSec: 60 } as const;

const THEME_SCRIPT_HASH = `'sha256-${createHash('sha256').update(themeScript).digest('base64')}'`;

/**
 * The CSP of a share page response. `dev` adds what `next dev` needs (eval for React, HMR socket);
 * `upgrade-insecure-requests` only when served over https (it would break plain-http self-hosting).
 */
export function shareContentSecurityPolicy(nonce: string, dev: boolean, https = !dev): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${THEME_SCRIPT_HASH}${dev ? ` 'unsafe-eval'` : ''}`,
    // Inline style attributes come from UI primitives; document HTML never carries any (sanitised).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(!dev && https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/**
 * `TRUST_PROXY_HEADERS`: `1`/`true` or `0`/`false`; unset → trusted only on Vercel (`VERCEL` set), whose
 * edge overwrites the forwarding headers so clients can't spoof them.
 */
export function trustProxyHeadersFromEnv(env: Record<string, string | undefined>): boolean {
  const value = env.TRUST_PROXY_HEADERS?.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return Boolean(env.VERCEL);
}

const firstHop = (value: string | null) => value?.split(',')[0]?.trim() || undefined;
const lastHop = (value: string | null) => value?.split(',').at(-1)?.trim() || undefined;

/**
 * The client IP to rate-limit on.
 * - Trusted proxy headers (Vercel, or a proxy you configured to overwrite them): `x-vercel-forwarded-for`,
 *   then `x-real-ip`, then the first `x-forwarded-for` hop.
 * - Untrusted (default off Vercel): the socket address. The proxy can't read the socket directly; Next's
 *   server writes it into `x-forwarded-for` when the request has none, and an appending reverse proxy
 *   (nginx `$proxy_add_x_forwarded_for`, …) puts the peer it saw last — so the *last* hop is used, never a
 *   client-chosen first hop.
 * Falls back to one shared bucket (`unknown`).
 */
export function clientIp(request: Request, options: { trustProxyHeaders: boolean }): string {
  const h = request.headers;
  if (options.trustProxyHeaders) {
    return (
      firstHop(h.get('x-vercel-forwarded-for')) ??
      h.get('x-real-ip')?.trim() ??
      firstHop(h.get('x-forwarded-for')) ??
      'unknown'
    );
  }
  return lastHop(h.get('x-forwarded-for')) ?? 'unknown';
}

const TOKEN_SEGMENT = /^\/share\/([A-Za-z0-9_-]{1,128})\/?$/;

function tooMany(retryAfter: number): NextResponse {
  return new NextResponse('Too many requests. Try again in a minute.', {
    status: 429,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(retryAfter),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export async function guardShareRequest(
  request: NextRequest,
  limiter: RateLimiter,
  options: { dev: boolean; trustProxyHeaders: boolean },
): Promise<NextResponse> {
  const ip = clientIp(request, options);
  const perIp = await limiter.hit(
    `share:ip:${ip}`,
    SHARE_RATE_LIMIT.limit,
    SHARE_RATE_LIMIT.windowSec,
  );
  if (!perIp.allowed) return tooMany(perIp.retryAfter);
  const token = TOKEN_SEGMENT.exec(request.nextUrl.pathname)?.[1] ?? 'malformed';
  const perToken = await limiter.hit(
    `share:token:${token}`,
    SHARE_TOKEN_RATE_LIMIT.limit,
    SHARE_TOKEN_RATE_LIMIT.windowSec,
  );
  if (!perToken.allowed) return tooMany(perToken.retryAfter);

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = shareContentSecurityPolicy(
    nonce,
    options.dev,
    request.nextUrl.protocol === 'https:' ||
      (options.trustProxyHeaders && request.headers.get('x-forwarded-proto') === 'https'),
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('cookie');
  requestHeaders.delete('authorization');
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('cache-control', 'private, no-store');
  return response;
}
