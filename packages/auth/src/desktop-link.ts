/**
 * Desktop sign-in hand-off (task 1.8), the parts shared by the web app and the desktop main process.
 * Dependency-free (Web Crypto only), so the Electron main bundle can import it without Better Auth.
 *
 * Flow (an OAuth-style authorization code with PKCE, RFC 7636):
 * 1. Desktop makes a random `state` and a PKCE `verifier`, keeps both in memory, and opens the browser at
 *    `${web}/desktop/sign-in?state=…&challenge=S256(verifier)`.
 * 2. The web page (signed in, after the normal sign-in if needed) POSTs `state` + `challenge` to
 *    `/api/auth/desktop/code`, which stores a one-time code bound to the user and the challenge and
 *    returns `oat://auth?code=…&state=…`; the page opens it.
 * 3. Desktop receives the deep link, checks `state` against the one it made (single use), and POSTs
 *    `code` + `verifier` to `/api/auth/desktop/token`. The server consumes the code, checks
 *    S256(verifier) = challenge, creates a new session and returns its signed bearer token.
 *
 * `state` stops a link the desktop didn't ask for from signing it in (login CSRF); PKCE stops another app
 * that intercepts the `oat://` link from redeeming the code.
 */

/** The custom URL scheme the desktop app registers. */
export const DESKTOP_SCHEME = 'oat';
/** `oat://auth?code=…&state=…`: host part of the sign-in callback. */
export const DESKTOP_AUTH_HOST = 'auth';
/** Web page the desktop opens in the browser. */
export const DESKTOP_SIGN_IN_PATH = '/desktop/sign-in';
/** Better Auth endpoints (under `/api/auth`) added by the `desktopAuth` plugin. */
export const DESKTOP_CODE_ENDPOINT = '/desktop/code';
export const DESKTOP_TOKEN_ENDPOINT = '/desktop/token';
/** Response header carrying the signed session token (Better Auth's bearer plugin). */
export const AUTH_TOKEN_HEADER = 'set-auth-token';

/** 32 random bytes, base64url without padding: always exactly 43 characters. */
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** `state`, PKCE verifier/challenge and one-time codes all share this format. */
export function isDesktopAuthValue(value: unknown): value is string {
  return typeof value === 'string' && RANDOM_VALUE.test(value);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes from the platform CSPRNG, base64url (43 chars). */
export function randomDesktopValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Constant-time string comparison (both values are short, fixed-format strings). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The URL the desktop opens in the browser. */
export function desktopSignInUrl(webBaseUrl: string, state: string, challenge: string): string {
  const url = new URL(DESKTOP_SIGN_IN_PATH, webBaseUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('challenge', challenge);
  return url.toString();
}

/** `oat://auth?code=…&state=…` */
export function desktopCallbackUrl(code: string, state: string): string {
  const params = new URLSearchParams({ code, state });
  return `${DESKTOP_SCHEME}://${DESKTOP_AUTH_HOST}?${params.toString()}`;
}

export type DesktopDeepLink = { kind: 'auth'; code: string; state: string };

/**
 * Parses a deep link the OS handed the app. Only `oat://auth?code=<43>&state=<43>` is understood;
 * anything else (other scheme or host, credentials, a port, a path, missing or malformed or repeated
 * params) is `null`.
 */
export function parseDesktopDeepLink(raw: unknown): DesktopDeepLink | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DESKTOP_SCHEME}:`) return null;
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.hostname !== DESKTOP_AUTH_HOST) return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  const codes = url.searchParams.getAll('code');
  const states = url.searchParams.getAll('state');
  if (codes.length !== 1 || states.length !== 1) return null;
  const [code] = codes;
  const [state] = states;
  if (!isDesktopAuthValue(code) || !isDesktopAuthValue(state)) return null;
  return { kind: 'auth', code, state };
}

/** The first `oat://` argument (Windows/Linux pass deep links on the command line of a second instance). */
export function findDeepLinkArg(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${DESKTOP_SCHEME}://`));
}
