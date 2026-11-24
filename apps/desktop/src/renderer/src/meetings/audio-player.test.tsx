// @vitest-environment jsdom
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
  vi.restoreAllMocks();
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

it('clears playing when leaving a meeting even if reloading the audio cancels its pause event', async () => {
  vi.mocked(call).mockImplementation(async (_channel, request) => {
    const { meetingId } = request as { meetingId: string };
    return {
      meetingId,
      status: 'available',
      url: `oat-audio://local/${meetingId}/`,
      durationMs: 1000,
      parts: [{ part: 1, startMs: 0, endMs: 1000, sources: ['mic'], partial: false }],
    } as Awaited<ReturnType<typeof call>>;
  });
  // The HTML media element can discard a queued pause event when its source is removed.
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  function Player({ id }: { id: string | null }) {
    const { audioRef, player } = useMeetingPlayback(id);
    return <audio ref={audioRef} data-testid="audio" data-playing={player.playing} />;
  }
  const { rerender } = render(<Player id="first" />);
  const audio = screen.getByTestId('audio');
  await waitFor(() => expect(audio.getAttribute('src')).toContain('/first/'));
  fireEvent.play(audio);
  expect(audio.getAttribute('data-playing')).toBe('true');

  rerender(<Player id={null} />);
  rerender(<Player id="second" />);
  await waitFor(() => expect(audio.getAttribute('src')).toContain('/second/'));
  expect(audio.getAttribute('data-playing')).toBe('false');
});
