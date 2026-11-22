// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRouteHistory } from './use-route-history';
import { routeStorageKey } from './route-history';
const model = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('./bridge', () => ({ call: model.call, bridge: () => ({ subscribe: model.subscribe }) }));
beforeEach(() => {
  model.call.mockReset().mockResolvedValue(null);
  model.subscribe.mockReset().mockReturnValue(model.unsubscribe);
  model.unsubscribe.mockClear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it('restores search filters, handles keyboard/mouse back and forward, and persists the current route', () => {
  localStorage.setItem(routeStorageKey('u'), '/search?q=meeting&type=transcripts');
  const { result } = renderHook(() => useRouteHistory('u'));
  expect(result.current.route).toEqual({ view: 'search', q: 'meeting', type: 'transcripts' });
  act(() => result.current.navigate({ view: 'document', id: 'd', query: { block: 'b' } }));
  fireEvent.keyDown(window, { key: '[', metaKey: true });
  expect(result.current.route.view).toBe('search');
  fireEvent.keyDown(window, { key: ']', ctrlKey: true });
  expect(result.current.route).toMatchObject({ view: 'document', id: 'd' });
  fireEvent.mouseDown(window, { button: 3 });
  expect(result.current.route.view).toBe('search');
  fireEvent.mouseDown(window, { button: 4 });
  expect(result.current.route.view).toBe('document');
  expect(localStorage.getItem(routeStorageKey('u'))).toBe('/d/d?block=b');
});
it('feeds invite queue delivery into the same history without persisting the token', async () => {
  const { result } = renderHook(() => useRouteHistory('u'));
  await waitFor(() => expect(model.call).toHaveBeenCalledWith('navigation:get'));
  act(() => result.current.navigate({ view: 'settings', section: 'integrations' }));
  model.call.mockResolvedValue({ view: 'invite', token: 'a'.repeat(32) });
  await act(async () => {
    model.subscribe.mock.calls[0]![1]();
  });
  expect(result.current.route).toEqual({ view: 'invite', token: 'a'.repeat(32) });
  expect(localStorage.getItem(routeStorageKey('u'))).toBe('/settings/integrations');
  fireEvent.keyDown(window, { key: '[', metaKey: true });
  expect(result.current.route).toEqual({ view: 'settings', section: 'integrations' });
  fireEvent.keyDown(window, { key: ']', metaKey: true });
  expect(result.current.route.view).toBe('invite');
});
it('ignores stale invite replies after queue clearing and unsubscribes on unmount', async () => {
  let resolve!: (value: unknown) => void;
  model.call.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { result, unmount } = renderHook(() => useRouteHistory('u'));
  await act(async () => {
    model.subscribe.mock.calls[0]![1]();
  });
  await act(async () => {
    resolve({ view: 'invite', token: 'a'.repeat(32) });
  });
  expect(result.current.route).toEqual({ view: 'home' });
  unmount();
  expect(model.unsubscribe).toHaveBeenCalledOnce();
});
it('keeps guarded/editor-owned history shortcuts untouched and functional updates in the same router', () => {
  const { result } = renderHook(() => useRouteHistory('u'));
  act(() =>
    result.current.setRoute((route) =>
      route.view === 'home' ? { view: 'settings' } : { view: 'home' },
    ),
  );
  const event = new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true });
  event.preventDefault();
  act(() => window.dispatchEvent(event));
  expect(result.current.route.view).toBe('settings');
  fireEvent.keyDown(window, { key: '[', metaKey: true, repeat: true });
  expect(result.current.route.view).toBe('settings');
});
