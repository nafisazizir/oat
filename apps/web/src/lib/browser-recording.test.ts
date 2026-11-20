import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserRecording } from './browser-recording';
import { meetingApi } from './meeting';
import { BrowserAudioArchive } from './audio-store';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser capture failures', () => {
  it('releases a late microphone grant after shell disposal without starting STT', async () => {
    vi.stubGlobal('window', new EventTarget());
    let grant!: (media: unknown) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const recording = new BrowserRecording();
    const starting = recording.start('document', false, 'alice');
    await recording.endSession(false);
    grant({ getTracks: () => [{ stop }] });
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(recording.snapshot()).toMatchObject({ status: 'idle', pending: 0, segments: [] });
  });

  it.each(['sign out', 'account change', 'shell unmount'])(
    'stops tracks and sockets and finalizes the archive on %s',
    async (reason) => {
      vi.stubGlobal('window', new EventTarget());
      const stop = vi.fn();
      const track = { stop, addEventListener: vi.fn() };
      vi.stubGlobal('navigator', {
        mediaDevices: {
          getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
        },
      });
      const disconnect = vi.fn();
      class Node {
        port = {};
        gain = { value: 1 };
        connect() {
          return this;
        }
        disconnect = disconnect;
      }
      const closeContext = vi.fn(async () => {});
      vi.stubGlobal(
        'AudioContext',
        class {
          currentTime = 1;
          destination = new Node();
          audioWorklet = { addModule: async () => {} };
          resume = async () => {};
          close = closeContext;
          createGain = () => new Node();
          createMediaStreamSource = () => new Node();
        },
      );
      vi.stubGlobal('AudioWorkletNode', Node);
      vi.stubGlobal('MediaStream', class {});
      const closeSocket = vi.fn();
      vi.stubGlobal(
        'WebSocket',
        class {
          close = closeSocket;
        },
      );
      vi.spyOn(BrowserAudioArchive.prototype, 'start').mockResolvedValue();
      const finalize = vi.spyOn(BrowserAudioArchive.prototype, 'end').mockResolvedValue();
      vi.spyOn(meetingApi, 'get').mockResolvedValue({
        meetingId: 'meeting',
        startedAt: null,
        endedAt: null,
        participants: [],
      });
      const pushed: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string, init: RequestInit) => {
          if (path === '/api/stt/token')
            return Response.json({
              accessToken: 'grant',
              listenUrl: 'ws://localhost/listen',
              keyterms: [],
            });
          const body = JSON.parse(init.body as string);
          pushed.push(...body.entries);
          return Response.json({
            results: body.entries.map((entry: { version: number }) => ({
              version: entry.version,
              status: 'ok',
            })),
          });
        }),
      );
      const recording = new BrowserRecording();
      await recording.start('document', false, 'alice');
      await recording.sessionChanged('alice');
      expect(stop).not.toHaveBeenCalled();
      if (reason === 'account change') await recording.sessionChanged('bob');
      else await recording.endSession(reason === 'sign out');
      expect(stop).toHaveBeenCalledOnce();
      expect(closeSocket).toHaveBeenCalledOnce();
      expect(closeContext).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalled();
      expect(finalize).toHaveBeenCalledWith(0, true);
      expect(recording.snapshot()).toMatchObject({
        status: 'idle',
        documentId: null,
        segments: [],
      });
      if (reason === 'sign out')
        expect(pushed).toContainEqual(
          expect.objectContaining({
            table: 'meeting',
            row: expect.objectContaining({ endedAt: expect.any(String) }),
          }),
        );
    },
  );
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
    await recording.start('document', false, 'alice');
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
    const start = recording.start('document', false, 'alice');
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
    await recording.start('document', true, 'alice');
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recording.snapshot().error).toContain('Share tab audio');
    expect(recording.snapshot().status).toBe('idle');
    expect(video.stop).toHaveBeenCalled();
  });
});
