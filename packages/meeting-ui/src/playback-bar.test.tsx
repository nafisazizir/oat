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
    const { container, rerender } = render(<PlaybackBar player={player} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="playback"]')).not.toBeNull();
    rerender(
      <PlaybackBar
        player={{
          ...player,
          available: false,
          info: { status: 'none', parts: [], durationMs: 0, meetingId: 'meeting', url: null },
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
    const event = {
      defaultPrevented: false,
      key: 'ArrowRight',
      target: container,
      preventDefault: vi.fn(),
    };
    expect(playerKey(event as unknown as Parameters<typeof playerKey>[0], player)).toBe(true);
    expect(seekBy).toHaveBeenCalledWith(5000);
  });
  it('shows source choices only when the recording includes both mic and system audio', () => {
    const player: MeetingPlayback = {
      info: {
        meetingId: 'meeting',
        status: 'available',
        url: 'oat-audio://local/mix.wav',
        durationMs: 1000,
        parts: [],
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
      seekBy: vi.fn(),
      toggle: vi.fn(),
      pause: vi.fn(),
      setSource: vi.fn(),
      cycleSpeed: vi.fn(),
      retry: vi.fn(),
    };
    const { rerender } = render(<PlaybackBar player={player} />);
    for (const sources of [[], ['mic'], ['system'], ['mic', 'system']] as const) {
      player.info!.parts = [
        { part: 1, startMs: 0, endMs: 1000, sources: [...sources], partial: false },
      ];
      rerender(<PlaybackBar player={player} />);
      expect(screen.queryByRole('radiogroup', { name: 'Listen to' }) !== null).toBe(
        sources.length === 2,
      );
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Me' }));
    expect(player.setSource).toHaveBeenCalledWith('mic');
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed 1×' }));
    expect(player.cycleSpeed).toHaveBeenCalledOnce();
    player.info!.parts = [
      { part: 1, startMs: 0, endMs: 500, sources: ['mic'], partial: false },
      { part: 2, startMs: 500, endMs: 1000, sources: ['system'], partial: false },
    ];
    rerender(<PlaybackBar player={player} />);
    expect(screen.queryByRole('radiogroup', { name: 'Listen to' })).not.toBeNull();
  });
});
