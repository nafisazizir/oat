/**
 * Renderer trust rules for the main process. Pure functions (no Electron imports), unit-tested.
 *
 * - The renderer is served from the privileged `app://oat` origin in builds, or from the electron-vite
 *   dev server in `pnpm dev`. Those origins are the only "trusted" ones.
 * - IPC is accepted only from a window's **main frame** whose URL has a trusted origin (no iframes, no
 *   page that navigated elsewhere).
 * - Navigation away from a trusted origin is blocked; http(s) links open in the system browser.
 */

/** Custom scheme the built renderer is served from (`app://oat/index.html`). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'oat';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The parts of Electron's `WebFrameMain` we look at. */
export interface FrameLike {
  readonly url: string;
  readonly parent: FrameLike | null;
}

/**
 * `scheme://host[:port]` of a URL, or `null`. Node's `URL#origin` is `"null"` for non-special schemes such
 * as `app:`, so those are built by hand.
 */
export function originOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === `${APP_SCHEME}:`) return url.host ? `${url.protocol}//${url.host}` : null;
  return url.origin === 'null' ? null : url.origin;
}

/** The origins our own renderer is loaded from. */
export function trustedOrigins(rendererDevUrl: string | undefined): ReadonlySet<string> {
  const origins = new Set([APP_ORIGIN]);
  const dev = rendererDevUrl ? originOf(rendererDevUrl) : null;
  if (dev) origins.add(dev);
  return origins;
}

/** IPC sender check: a main frame (not an iframe) currently showing one of our origins. */
export function isTrustedFrame(
  frame: FrameLike | null | undefined,
  origins: ReadonlySet<string>,
): boolean {
  if (!frame || frame.parent !== null) return false;
  const origin = originOf(frame.url);
  return origin !== null && origins.has(origin);
}

/** Links we hand to the system browser. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** What to do with a navigation of a window's main frame. */
export function navigationDecision(
  url: string,
  origins: ReadonlySet<string>,
): 'allow' | 'open-external' | 'block' {
  const origin = originOf(url);
  if (origin !== null && origins.has(origin)) return 'allow';
  return isSafeExternalUrl(url) ? 'open-external' : 'block';
}

/**
 * Content-Security-Policy for the renderer. Builds: scripts only from `app://oat`, no eval, no inline
 * scripts, nothing fetched from the network (the renderer never talks to the API; main does). Dev: the
 * Vite dev server needs an inline preamble (React refresh) and its HMR websocket.
 */
export function contentSecurityPolicy({ dev }: { dev: boolean }): string {
  const directives: Record<string, string> = {
    'default-src': "'none'",
    'script-src': dev ? "'self' 'unsafe-inline'" : "'self'",
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' data:",
    'font-src': "'self' data:",
    // Meeting audio from main's `oat-audio://` protocol (3.7); nothing else plays.
    'media-src': 'oat-audio:',
    'connect-src': dev ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'self'",
    'base-uri': "'none'",
    'form-action': "'none'",
    'frame-ancestors': "'none'",
    'object-src': "'none'",
  };
  return Object.entries(directives)
    .map(([key, value]) => `${key} ${value}`)
    .join('; ');
}
