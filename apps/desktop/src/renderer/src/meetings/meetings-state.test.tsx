// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMeetingNote } from './meetings-state';

const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge.ts', () => ({
  call: model.call,
  bridge: () => ({ subscribe: () => () => {} }),
}));
beforeEach(() => model.call.mockReset());
afterEach(cleanup);
it('loads a meeting through main, and retries an uncached offline meeting', async () => {
  model.call.mockResolvedValueOnce({ state: 'offline' });
  const { result } = renderHook(() => useMeetingNote('doc'));
  expect(result.current.loaded).toBe(false);
  await waitFor(() => expect(result.current.failure).toBe('offline'));
  model.call.mockResolvedValueOnce({
    state: 'ready',
    note: { documentId: 'doc', title: 'Cached remote' },
  });
  act(() => result.current.retry());
  expect(result.current.loaded).toBe(false);
  await waitFor(() => expect(result.current.note?.title).toBe('Cached remote'));
  expect(result.current.failure).toBeUndefined();
  expect(model.call).toHaveBeenLastCalledWith('meeting:load', { documentId: 'doc' });
});
it('keeps responses from a previous document from replacing the current meeting', async () => {
  let finish!: (value: unknown) => void;
  model.call.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(({ id }) => useMeetingNote(id), {
    initialProps: { id: 'old' },
  });
  model.call.mockResolvedValueOnce({ state: 'missing' });
  rerender({ id: 'current' });
  await waitFor(() => expect(result.current.failure).toBe('missing'));
  await act(async () => finish({ state: 'ready', note: { documentId: 'old' } }));
  expect(result.current.note).toBeNull();
  expect(result.current.failure).toBe('missing');
});
it('surfaces bridge errors as retryable load failures', async () => {
  model.call.mockRejectedValueOnce(new Error('unavailable'));
  const { result } = renderHook(() => useMeetingNote('doc'));
  await waitFor(() => expect(result.current.failure).toBe('error'));
  expect(result.current.loaded).toBe(true);
});
