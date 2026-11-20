// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { call } from '../bridge.ts';
import { useMeetingPlayback } from './audio-player.tsx';

vi.mock('../bridge.ts', () => ({
  call: vi.fn(),
  bridge: () => ({ subscribe: () => () => {} }),
  BridgeCallError: class extends Error {},
}));
afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it.each(['mic', 'system'] as const)(
  'falls back to %s without changing the stored preference, restoring it for a dual-source meeting',
  async (only) => {
    const preferred = only === 'mic' ? 'system' : 'mic';
    localStorage.setItem('oat.desktop.playback.source', JSON.stringify(preferred));
    const info = (meetingId: string, sources: ('mic' | 'system')[]) => ({
      meetingId,
      status: 'available',
      url: 'oat-audio://local/',
      durationMs: 1000,
      parts: [{ part: 1, startMs: 0, endMs: 1000, sources, partial: false }],
    });
    vi.mocked(call)
      .mockResolvedValueOnce(info('single', [only]))
      .mockResolvedValueOnce(info('both', ['mic', 'system']));
    const { result, rerender } = renderHook(({ id }) => useMeetingPlayback(id), {
      initialProps: { id: 'single' },
    });
    await waitFor(() => expect(result.current.player.info?.meetingId).toBe('single'));
    expect(result.current.player.source).toBe(only);
    expect(localStorage.getItem('oat.desktop.playback.source')).toBe(JSON.stringify(preferred));
    rerender({ id: 'both' });
    await waitFor(() => expect(result.current.player.info?.meetingId).toBe('both'));
    expect(result.current.player.source).toBe(preferred);
    expect(localStorage.getItem('oat.desktop.playback.source')).toBe(JSON.stringify(preferred));
  },
);
