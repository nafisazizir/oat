/**
 * Serving the built renderer from `app://oat/…` (privileged standard scheme, so it has a real origin for
 * CSP and the IPC sender check). Path resolution is pure and unit-tested: nothing outside the renderer
 * folder can be read.
 */
import { extname, isAbsolute, join, normalize, relative } from 'node:path';

import { APP_HOST, APP_SCHEME } from './security.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function mimeType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** The file under `root` that `url` names, or `null` (wrong scheme/host, traversal, encoded NUL…). */
export function resolveRendererFile(root: string, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(root, rel));
  const fromRoot = relative(root, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  return target;
}
