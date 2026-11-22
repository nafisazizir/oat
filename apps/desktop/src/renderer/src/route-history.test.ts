// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  historyRoute,
  historyShortcut,
  persistRoute,
  restoreRoute,
  RouteHistory,
  routeStorageKey,
} from './route-history';
import { hrefOf } from '@oat/workspace-ui/routes';
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
describe('desktop route history', () => {
  it('round-trips document focus, filters and settings through back/forward and replaces filters', () => {
    const history = new RouteHistory();
    const document = {
      view: 'document',
      id: 'note',
      query: { kind: 'meeting', seg: 's', t: '2', block: 'b' },
    } as const;
    history.navigate(document);
    history.navigate({
      view: 'tasks',
      filters: { view: 'assigned', due: 'overdue', status: 'open' },
    });
    history.navigate(
      { view: 'tasks', filters: { view: 'assigned', due: 'any', status: 'done' } },
      { replace: true },
    );
    history.move(-1);
    expect(history.route).toEqual(document);
    history.move(1);
    expect(history.route).toMatchObject({ view: 'tasks', filters: { due: 'any', status: 'done' } });
    history.navigate({ view: 'settings', section: 'integrations' });
    history.move(-1);
    history.navigate({ view: 'search', q: 'find me', type: 'transcripts' });
    expect(history.snapshot.canForward).toBe(false);
    expect(historyRoute(hrefOf(history.route))).toEqual(history.route);
  });
  it('refocuses identical citations without duplicating history, including a forward revisit', () => {
    const history = new RouteHistory();
    const route = { view: 'document', id: 'd', query: { block: 'b' } } as const;
    history.navigate(route);
    history.navigate(route);
    expect(history.snapshot.focusRevision).toBe(2);
    history.move(-1);
    expect(history.route).toEqual({ view: 'home' });
    history.move(1);
    expect(history.snapshot.focusRevision).toBe(3);
    history.move(1);
    expect(history.snapshot.focusRevision).toBe(3);
  });
  it('bounds history and leaves empty back/forward harmless', () => {
    const history = new RouteHistory();
    history.move(-1);
    history.move(1);
    expect(history.snapshot.canBack).toBe(false);
    for (let n = 0; n < 120; n++) history.navigate({ view: 'document', id: String(n) });
    for (let n = 0; n < 120; n++) history.move(-1);
    expect(history.route).toEqual({ view: 'document', id: '20' });
  });
  it('restores only the signed-in account’s last non-invite route', () => {
    persistRoute('u1', { view: 'settings', section: 'storage' });
    persistRoute('u2', { view: 'search', q: 'notes', type: 'notes' });
    persistRoute('u1', { view: 'invite', token: 'a'.repeat(32) });
    expect(restoreRoute('u1')).toEqual({ view: 'settings', section: 'storage' });
    expect(restoreRoute('u2')).toEqual({ view: 'search', q: 'notes', type: 'notes' });
    expect(restoreRoute('new')).toEqual({ view: 'home' });
    localStorage.setItem(routeStorageKey('u1'), '/invite/' + 'a'.repeat(32));
    expect(restoreRoute('u1')).toEqual({ view: 'home' });
  });
  it.each([
    'https://evil.test/d/a',
    '//evil.test/d/a',
    '/\\evil.test',
    '/d/%ZZ',
    '/home#fragment',
    '/home?ignored=1',
    '/invite/invalid',
    '/settings/../home',
    '/home\n',
    '/d/' + 'a'.repeat(8200),
  ])('rejects unsafe/noncanonical stored routes: %s', (raw) => {
    expect(historyRoute(raw)).toBeNull();
    localStorage.setItem(routeStorageKey('u'), raw);
    expect(restoreRoute('u')).toEqual({ view: 'home' });
  });
  it('tolerates unavailable storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Full');
    });
    expect(restoreRoute('u')).toEqual({ view: 'home' });
    expect(() => persistRoute('u', { view: 'home' })).not.toThrow();
  });
  it('matches Cmd/Ctrl brackets but respects owned, shifted and repeated events', () => {
    expect(historyShortcut(new KeyboardEvent('keydown', { key: '[', metaKey: true }))).toBe(-1);
    expect(historyShortcut(new KeyboardEvent('keydown', { key: ']', ctrlKey: true }))).toBe(1);
    for (const extra of [{ shiftKey: true }, { altKey: true }, { repeat: true }]) {
      expect(
        historyShortcut(new KeyboardEvent('keydown', { key: '[', metaKey: true, ...extra })),
      ).toBeNull();
    }
    const owned = new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true });
    owned.preventDefault();
    expect(historyShortcut(owned)).toBeNull();
  });
});
