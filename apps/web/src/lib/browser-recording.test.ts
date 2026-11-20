import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserRecording } from './browser-recording';
import { meetingApi } from './meeting';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser capture failures', () => {
  it('rechecks ended transcripts before starting and releases the granted microphone', async () => {
    vi.stubGlobal('window', new EventTarget());
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    const get = vi.spyOn(meetingApi, 'get').mockResolvedValue({
      meetingId: 'meeting',
      startedAt: '2026-11-20T00:00:00Z',
      endedAt: '2026-11-20T00:01:00Z',
      participants: [],
      transcript: [
        { id: 'segment', source: 'mic', speaker: 'Me', startMs: 0, text: 'Already recorded' },
      ],
    });
    const recording = new BrowserRecording();
    await recording.start('document', false);
    expect(get).toHaveBeenCalledWith('document', { recording: true, transcript: true });
    expect(recording.snapshot().error).toContain('finished transcript');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('warns during permission requests and exposes a denied permission for retry without leaking a session', async () => {
    const window = new EventTarget();
    vi.stubGlobal('window', window);
    let deny!: (error: Error) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          deny = reject;
        }),
    );
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const recording = new BrowserRecording();
    const start = recording.start('document', false);
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    deny(new Error('Permission denied'));
    await start;
    expect(recording.snapshot()).toMatchObject({
      status: 'idle',
      error: 'Permission denied',
      pending: 0,
    });
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it('requests tab sharing while activation is fresh and explains missing audio with resource cleanup', async () => {
    vi.stubGlobal('window', new EventTarget());
    const video = { stop: vi.fn() };
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn(async () => ({
      getVideoTracks: () => [video],
      getAudioTracks: () => [],
      getTracks: () => [video],
    }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia } });
    const recording = new BrowserRecording();
    await recording.start('document', true);
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recording.snapshot().error).toContain('Share tab audio');
    expect(recording.snapshot().status).toBe('idle');
    expect(video.stop).toHaveBeenCalled();
  });
});
