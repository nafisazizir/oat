import { INVITE_TOKEN } from '@oat/core/invite-link';
import { hrefOf, routeOf, type AppRoute } from '@oat/workspace-ui/routes';

const LIMIT = 100;
export const routeStorageKey = (userId: string) => `oat.route.v1:${userId}`;
export function historyRoute(raw: unknown): AppRoute | null {
  if (
    typeof raw !== 'string' ||
    raw.length > 8192 ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('#') ||
    [...raw].some((c) => c.charCodeAt(0) <= 32)
  )
    return null;
  try {
    const url = new URL(raw, 'https://oat.invalid');
    if (url.origin !== 'https://oat.invalid') return null;
    const route = routeOf(url.pathname, url.search);
    const canonical = new URL(hrefOf(route), 'https://oat.invalid');
    url.searchParams.sort();
    canonical.searchParams.sort();
    if (
      raw.split('?')[0] !== url.pathname ||
      canonical.pathname !== url.pathname ||
      canonical.search !== url.search ||
      (route.view === 'invite' && !INVITE_TOKEN.test(route.token))
    )
      return null;
    return route;
  } catch {
    return null;
  }
}
export function restoreRoute(userId: string): AppRoute {
  try {
    const route = historyRoute(localStorage.getItem(routeStorageKey(userId)));
    return route && route.view !== 'invite' ? route : { view: 'home' };
  } catch {
    return { view: 'home' };
  }
}
export function persistRoute(userId: string, route: AppRoute): void {
  if (route.view === 'invite') return;
  try {
    localStorage.setItem(routeStorageKey(userId), hrefOf(route));
  } catch {
    /* Navigation works without storage. */
  }
}
function canonicalRoute(route: AppRoute): AppRoute | null {
  try {
    return historyRoute(hrefOf(route));
  } catch {
    return null;
  }
}
export class RouteHistory {
  #entries: AppRoute[];
  #index = 0;
  #focusRevision = 0;
  constructor(initial: AppRoute = { view: 'home' }) {
    this.#entries = [canonicalRoute(initial) ?? { view: 'home' }];
  }
  get route() {
    return this.#entries[this.#index]!;
  }
  get snapshot() {
    return {
      route: this.route,
      focusRevision: this.#focusRevision,
      canBack: this.#index > 0,
      canForward: this.#index < this.#entries.length - 1,
    };
  }
  navigate(next: AppRoute, options?: { replace?: boolean }) {
    const canonical = canonicalRoute(next);
    if (!canonical) return;
    if (hrefOf(canonical) !== hrefOf(this.route)) {
      if (options?.replace) this.#entries[this.#index] = canonical;
      else {
        this.#entries = [...this.#entries.slice(0, this.#index + 1), canonical].slice(-LIMIT);
        this.#index = this.#entries.length - 1;
      }
    }
    if (canonical.view === 'document') this.#focusRevision++;
  }
  move(direction: -1 | 1) {
    const index = this.#index + direction;
    if (index < 0 || index >= this.#entries.length) return;
    this.#index = index;
    if (this.route.view === 'document') this.#focusRevision++;
  }
}
export function historyShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
  >,
): -1 | 1 | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    !(event.metaKey || event.ctrlKey)
  )
    return null;
  return event.key === '[' ? -1 : event.key === ']' ? 1 : null;
}
