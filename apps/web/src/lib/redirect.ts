/** Where signed-in users land by default. */
export const DEFAULT_SIGNED_IN_PATH = '/home';

const BASE = 'http://oat.invalid';
/** `scheme:` anywhere, e.g. `javascript:` or `https://`. */
const SCHEME = /[a-z][a-z0-9+.-]*:/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Fully percent-decodes `value` (repeatedly, so `%252f` counts too). `null` if it isn't valid encoding. */
function fullyDecoded(value: string): string | null {
  let current = value;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null; // still changing after 5 rounds: refuse rather than guess
}

/** True when a browser could read `path` as anything but a path on this origin. */
function isUnsafeAsIs(path: string): boolean {
  if (!path.startsWith('/')) return true;
  if (path.startsWith('//') || path.startsWith('/\\')) return true;
  if (path.includes('\\') || CONTROL.test(path) || SCHEME.test(path)) return true;
  return false;
}

/** `isUnsafeAsIs` for `path` and for its dot-segment-normalised form (`/a/..//x` → `//x`). */
function isUnsafe(path: string): boolean {
  if (isUnsafeAsIs(path)) return true;
  try {
    const url = new URL(path, BASE);
    return url.origin !== BASE || isUnsafeAsIs(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return true;
  }
}

/**
 * A same-origin path to return to after sign-in, or `/home`. Checks the raw value, its fully-decoded
 * form, the normalised result (`/.//x` and `/a/..//x` normalise to `//x`) and the decoded normalised
 * result, so `?next=` can't become an open redirect; anything doubtful falls back to `/home`.
 */
export function safeNextPath(value: string | string[] | null | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  if (!next) return DEFAULT_SIGNED_IN_PATH;
  const decoded = fullyDecoded(next);
  if (decoded === null || isUnsafe(next) || isUnsafe(decoded)) return DEFAULT_SIGNED_IN_PATH;

  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return DEFAULT_SIGNED_IN_PATH;
  }
  if (url.origin !== BASE) return DEFAULT_SIGNED_IN_PATH;
  const result = `${url.pathname}${url.search}${url.hash}`;
  const resultDecoded = fullyDecoded(result);
  if (resultDecoded === null || isUnsafe(result) || isUnsafe(resultDecoded)) {
    return DEFAULT_SIGNED_IN_PATH;
  }
  // The result must also resolve back to this origin on its own (what the browser will do with it).
  if (new URL(result, BASE).origin !== BASE) return DEFAULT_SIGNED_IN_PATH;
  if (url.pathname === '/sign-in' || url.pathname.startsWith('/sign-in/')) {
    return DEFAULT_SIGNED_IN_PATH;
  }
  return result;
}

/** `/sign-in`, remembering where to go back to unless that's the default. */
export function signInPath(next?: string): `/sign-in${string}` {
  const target = safeNextPath(next);
  return target === DEFAULT_SIGNED_IN_PATH
    ? '/sign-in'
    : `/sign-in?next=${encodeURIComponent(target)}`;
}
