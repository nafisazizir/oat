import { magicLinkVerifyUrl } from '@oat/auth';

import { safeNextPath } from '@/lib/redirect';
import { getAuth, getAuthConfig } from '@/server/auth';

/** Request headers worth passing to Better Auth's verify call (cookies, client hints for the session). */
const FORWARDED = ['cookie', 'user-agent', 'x-forwarded-for', 'x-real-ip'];

/**
 * The browser says this POST comes from our own page: `Origin` equals ours, or (when a referrer policy
 * blanks it to `null`) the unforgeable `Sec-Fetch-Site: same-origin`.
 */
function isSameOrigin(request: Request, origin: string): boolean {
  const header = request.headers.get('origin');
  if (header) return header === origin || (header === 'null' && sameOriginFetch(request));
  return sameOriginFetch(request);
}

const sameOriginFetch = (request: Request) =>
  request.headers.get('sec-fetch-site') === 'same-origin';

/**
 * Consumes a magic link: the confirm page (`/sign-in/confirm`) POSTs `token` + `next` here, and we run
 * Better Auth's verify endpoint in-process and hand its answer (session cookie + redirect) back as a
 * 303. Link scanners only ever GET the confirm page, so they can't use up the token.
 *
 * Same-origin only (Origin header must match `BETTER_AUTH_URL`): otherwise another site could post its
 * own token and sign a visitor into the attacker's account (login CSRF).
 */
export async function POST(request: Request) {
  const { baseURL } = getAuthConfig();
  if (!isSameOrigin(request, new URL(baseURL).origin)) {
    return new Response('Forbidden', { status: 403 });
  }
  const form = await request.formData().catch(() => null);
  const token = form?.get('token');
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
    return Response.redirect(new URL('/sign-in?error=INVALID_TOKEN', baseURL), 303);
  }
  const next = safeNextPath(
    typeof form?.get('next') === 'string' ? String(form.get('next')) : null,
  );

  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const verified = await getAuth().handler(
    new Request(magicLinkVerifyUrl(baseURL, token, next), { headers }),
  );

  // Better Auth answers 302 + Location (+ Set-Cookie on success). Re-issue as 303 so the browser
  // follows with a GET whatever it does with 302-after-POST.
  const location = verified.headers.get('location') ?? '/sign-in?error=INVALID_TOKEN';
  const response = new Response(null, { status: 303, headers: { location } });
  for (const cookie of verified.headers.getSetCookie())
    response.headers.append('set-cookie', cookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}
