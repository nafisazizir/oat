/**
 * Listening back to a meeting (3.7): `useMeetingPlayback` owns the `<audio>` element (rendered by the meeting
 * view, so playback survives the panel re-rendering) and the playhead clock; `PlaybackBar` is the compact
 * player at the top of the transcript panel — play/pause, time, source (Me / Them / Both), speed, and a
 * scrubber over the whole meeting clock with its recording sessions (parts) and the gaps between them.
 * Without audio on this Mac it says why (deleted / on another device / recording / none).
 *
 * Keyboard (in the player and the transcript): Space plays/pauses, ←/→ move 5 s. The scrubber is a slider
 * (←/→ 5 s, PageUp/PageDown 30 s, Home/End).
 */
import type { PlaybackInfo, PlaybackSource } from '@oat/core/bridge';
import { useStoredState } from '@oat/meeting-ui';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { MeetingPlayback } from '@oat/meeting-ui';
export { PlaybackBar, playerKey, type MeetingPlayback } from '@oat/meeting-ui';
import { BridgeCallError, bridge, call } from '../bridge.ts';
import {
  clampMs,
  isSource,
  isSpeed,
  nextSpeed,
  PlaybackClock,
  seekTarget,
  skipGap,
} from './playback.ts';

const errorText = (e: unknown) =>
  e instanceof BridgeCallError ? e.message : 'Couldn’t load the audio.';

/**
 * The meeting's player. `audioRef` goes on an `<audio>` element that is always mounted while a note is
 * open (the meeting view renders it), so the effects below find it.
 */
export function useMeetingPlayback(meetingId: string | null): {
  audioRef: RefObject<HTMLAudioElement | null>;
  player: MeetingPlayback;
} {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [clock] = useState(() => new PlaybackClock());
  const [loaded, setLoaded] = useState<{ meetingId: string; info: PlaybackInfo } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A playback error belongs to the source URL (and attempt) it happened on.
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [seekCount, setSeekCount] = useState(0);
  const [storedSource, setSource] = useStoredState<string>('oat.desktop.playback.source', 'mix');
  const [storedSpeed, setSpeed] = useStoredState<number>('oat.desktop.playback.speed', 1);
  const source: PlaybackSource = isSource(storedSource) ? storedSource : 'mix';
  const speed = isSpeed(storedSpeed) ? storedSpeed : 1;

  // (Re)load the timeline + URL: on another meeting, and whenever the archive changes (a recording ended,
  // audio deleted by the user or the retention sweeper).
  const [version, setVersion] = useState(0);
  useEffect(() => bridge().subscribe('storage:changed', () => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!meetingId) return;
    let live = true;
    call('playback:open', { meetingId }).then(
      (info) => {
        if (!live) return;
        setLoaded({ meetingId, info });
        setLoadError(null);
      },
      (e: unknown) => live && setLoadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [meetingId, version]);

  const info = loaded && loaded.meetingId === meetingId ? loaded.info : null;
  const url = info?.status === 'available' ? info.url : null;
  // The WAV's length is the timeline's: a new recording session makes a new URL, so the element reloads.
  const src = url ? `${url}${source}.wav?v=${Math.round(info!.durationMs)}` : null;
  const srcKey = src && `${src}#${attempt}`;
  const playError = failed !== null && failed === srcKey ? 'Couldn’t play the audio.' : null;
  const parts = info?.parts;
  const durationMs = info?.durationMs ?? 0;

  // The element follows `src`, keeping the position (and playing state) across a source switch; another
  // meeting starts at 0.
  useEffect(() => clock.set(0), [meetingId, clock]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!src) {
      audio.pause();
      if (audio.hasAttribute('src')) {
        audio.removeAttribute('src');
        audio.load();
      }
      return;
    }
    if (audio.getAttribute('src') === src && attempt === 0) return;
    const resume = !audio.paused;
    audio.src = src;
    audio.playbackRate = speed;
    // The playhead as it is once the new stream can seek (a click may have moved it meanwhile).
    const restore = () => {
      audio.currentTime = clock.ms / 1000;
      if (resume) void audio.play().catch(() => undefined);
    };
    audio.addEventListener('loadedmetadata', restore, { once: true });
    return () => audio.removeEventListener('loadedmetadata', restore);
    // `speed` is applied by its own effect; reading it here only seeds a fresh source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, attempt, clock]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // Element events → state; while playing, the clock follows `currentTime` every frame and gaps between
  // recording sessions are skipped.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let frame = 0;
    const tick = () => {
      const ms = audio.currentTime * 1000;
      const skip = parts ? skipGap(parts, ms) : null;
      if (skip !== null) audio.currentTime = skip / 1000;
      clock.set(skip ?? ms);
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      setBuffering(false);
      cancelAnimationFrame(frame);
      clock.set(audio.currentTime * 1000);
    };
    const onWaiting = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onError = () => {
      if (!srcKey || !audio.getAttribute('src')) return;
      onPause();
      setFailed(srcKey);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onReady);
    audio.addEventListener('canplay', onReady);
    audio.addEventListener('error', onError);
    if (!audio.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onReady);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('error', onError);
    };
  }, [parts, clock, srcKey]);

  const available = src !== null && playError === null;

  const seek = useCallback(
    (ms: number) => {
      const target = seekTarget(parts ?? [], ms, durationMs);
      clock.set(target);
      setSeekCount((n) => n + 1);
      const audio = audioRef.current;
      if (audio && src) audio.currentTime = target / 1000;
    },
    [parts, durationMs, clock, src],
  );
  const seekBy = useCallback(
    (delta: number) => seek(clampMs(clock.ms + delta, durationMs)),
    [seek, clock, durationMs],
  );
  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    if (audio.paused) {
      if (audio.ended || clock.ms >= durationMs - 50) audio.currentTime = 0;
      audio.play().catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError' && srcKey) setFailed(srcKey);
      });
    } else audio.pause();
  }, [src, srcKey, clock, durationMs]);
  const pause = useCallback(() => audioRef.current?.pause(), []);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    setVersion((v) => v + 1);
  }, []);

  const player: MeetingPlayback = {
    info,
    available,
    loadError,
    playError,
    playing,
    buffering,
    clock,
    seekCount,
    source,
    speed,
    seek,
    seekBy,
    toggle,
    pause,
    setSource: (s) => setSource(s),
    cycleSpeed: () => setSpeed(nextSpeed(speed)),
    retry,
  };
  return { audioRef, player };
}
