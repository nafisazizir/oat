// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackBar, playerKey, type MeetingPlayback } from './playback-bar.tsx';
import { PlaybackClock } from './playback.ts';

describe('injected shared playback controller', () => {
  it('renders a neutral blob URL and forwards play, speed, source and keyboard seeks', () => {
    const toggle = vi.fn();
    const seekBy = vi.fn();
    const cycleSpeed = vi.fn();
    const setSource = vi.fn();
    const player: MeetingPlayback = {
      info: {
        meetingId: 'meeting',
        status: 'available',
        url: 'blob:local-audio',
        durationMs: 10000,
        parts: [{ part: 1, startMs: 0, endMs: 10000, sources: ['mic'], partial: false }],
      },
      available: true,
      loadError: null,
      playError: null,
      playing: false,
      buffering: false,
      clock: new PlaybackClock(),
      seekCount: 0,
      source: 'mix',
      speed: 1,
      seek: vi.fn(),
      seekBy,
      toggle,
      pause: vi.fn(),
      setSource,
      cycleSpeed,
      retry: vi.fn(),
    };
    const { container } = render(<PlaybackBar player={player} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="playback"]')).not.toBeNull();
    const event = {
      defaultPrevented: false,
      key: 'ArrowRight',
      target: container,
      preventDefault: vi.fn(),
    };
    expect(playerKey(event as unknown as Parameters<typeof playerKey>[0], player)).toBe(true);
    expect(seekBy).toHaveBeenCalledWith(5000);
  });
});
