// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConflictsPanel } from './conflicts-panel';
const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge.ts', () => ({ call: model.call, BridgeCallError: class extends Error {} }));
const summary = {
  copyId: 'c',
  title: 'Copy',
  originalTitle: 'Note',
  device: 'Mac',
  at: null,
  originalId: 'd',
};
const detail = {
  revision: 'a'.repeat(64),
  summary,
  original: [{ text: 'Original', changed: true }],
  copy: [{ text: 'Copy', changed: true }],
};
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  model.call.mockReset();
  model.call.mockImplementation(async (channel: string) =>
    channel === 'conflicts:list'
      ? { conflicts: [summary] }
      : channel === 'conflicts:get'
        ? detail
        : { resolved: true },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps an empty list hidden once loaded', async () => {
  model.call.mockResolvedValue({ conflicts: [] });
  render(<ConflictsPanel refreshKey={null} />);
  await waitFor(() => expect(screen.queryByTestId('conflicts')).toBeNull());
});
it('exposes list failure and retries before opening a comparison', async () => {
  model.call.mockRejectedValueOnce(new Error('Disk unavailable'));
  render(<ConflictsPanel refreshKey={null} />);
  expect(await screen.findByText('Couldn’t load conflicted copies.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  fireEvent.click(await screen.findByRole('button', { name: /Note/ }));
  expect(await screen.findByTestId('compare-original')).toBeTruthy();
});
it.each(['error', 'missing'])(
  'exposes %s detail with retry and resolves through local IPC only',
  async (failure) => {
    model.call.mockImplementation(async (channel: string) => {
      if (channel === 'conflicts:list') return { conflicts: [summary] };
      if (channel === 'conflicts:get') {
        if (failure === 'error') throw new Error('Read failed');
        return null;
      }
      return { resolved: true };
    });
    render(<ConflictsPanel refreshKey={null} />);
    fireEvent.click(await screen.findByRole('button', { name: /Note/ }));
    expect(
      await screen.findByText(
        failure === 'error'
          ? 'Couldn’t load this conflicted copy.'
          : 'This copy is unavailable. It may already be resolved.',
      ),
    ).toBeTruthy();
    model.call.mockImplementation(async (channel: string) =>
      channel === 'conflicts:get'
        ? detail
        : channel === 'conflicts:list'
          ? { conflicts: [] }
          : { resolved: true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('compare-copy');
    fireEvent.click(screen.getByRole('button', { name: 'Keep this copy' }));
    await waitFor(() =>
      expect(model.call).toHaveBeenCalledWith('conflicts:resolve', {
        copyId: 'c',
        keep: 'copy',
        revision: detail.revision,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('conflict-compare')).toBeNull());
  },
);
it('reports refused resolution without dismissing the comparison', async () => {
  render(<ConflictsPanel refreshKey={null} />);
  fireEvent.click(await screen.findByRole('button', { name: /Note/ }));
  await screen.findByTestId('compare-copy');
  model.call.mockResolvedValue({ resolved: false });
  fireEvent.click(screen.getByRole('button', { name: 'Keep other version' }));
  expect(await screen.findByText(/This copy changed or was resolved/)).toBeTruthy();
  expect(screen.getByTestId('conflict-compare')).toBeTruthy();
  model.call.mockResolvedValue(detail);
  fireEvent.click(screen.getByRole('button', { name: 'Compare again' }));
  await waitFor(() => expect(screen.queryByText(/This copy changed or was resolved/)).toBeNull());
  expect(await screen.findByTestId('compare-copy')).toBeTruthy();
});
