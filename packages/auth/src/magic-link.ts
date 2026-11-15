/**
 * Magic links point at a confirm page, not at the verify endpoint: email link scanners (corporate mail
 * gateways, previews) fetch every link with GET, which would consume the single-use token and mint a
 * session for the scanner. The confirm page shows a button that POSTs the token back; only that POST
 * (same-origin) calls Better Auth's verify endpoint.
 *
 *   email → GET /sign-in/confirm?token=…&next=… → POST /api/sign-in/magic-link → verify → 303 → next
 */

/** The page the email links to (apps/web `(auth)/sign-in/confirm`). */
export const MAGIC_LINK_CONFIRM_PATH = '/sign-in/confirm';
/** The same-origin POST endpoint the confirm page submits to (apps/web route handler). */
export const MAGIC_LINK_CONSUME_PATH = '/api/sign-in/magic-link';
/** Better Auth's verify endpoint: only ever called in-process by the consume route, never over HTTP. */
export const MAGIC_LINK_VERIFY_PATH = '/api/auth/magic-link/verify';

/**
 * Auth API paths the public `/api/auth/*` route must not serve. The magic-link verify GET would let a
 * link from another site sign a visitor into the sender's account (login CSRF). Compared
 * case-insensitively and without trailing slashes / duplicate slashes, so variants can't slip past.
 */
export function isBlockedAuthPath(pathname: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const normalised = path
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return normalised === MAGIC_LINK_VERIFY_PATH;
}

/**
 * Turns the verify URL Better Auth hands to `sendMagicLink` into the confirm-page URL we email. Keeps
 * the token and the post-sign-in path (`callbackURL`, relative to the app).
 */
export function magicLinkConfirmUrl(baseURL: string, verifyUrl: string): string {
  const verify = new URL(verifyUrl);
  const token = verify.searchParams.get('token');
  if (!token) throw new Error('magic link without a token');
  const confirm = new URL(MAGIC_LINK_CONFIRM_PATH, baseURL);
  confirm.searchParams.set('token', token);
  const callback = verify.searchParams.get('callbackURL');
  if (callback) {
    const target = new URL(callback, baseURL);
    if (target.origin === new URL(baseURL).origin) {
      confirm.searchParams.set('next', `${target.pathname}${target.search}${target.hash}`);
    }
  }
  return confirm.toString();
}

/**
 * The Better Auth verify URL for a confirmed token. `next` must already be a sanitised same-origin
 * path; failures land on `/sign-in?error=…`.
 */
export function magicLinkVerifyUrl(baseURL: string, token: string, next: string): string {
  const url = new URL(MAGIC_LINK_VERIFY_PATH, baseURL);
  url.searchParams.set('token', token);
  url.searchParams.set('callbackURL', next);
  url.searchParams.set('errorCallbackURL', '/sign-in');
  return url.toString();
}
