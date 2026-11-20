'use client';

import {
  type MeetingPlayback,
  PlaybackClock,
  type PlaybackInfo,
  type PlaybackSource,
} from '@oat/meeting-ui';
import { availablePlaybackSource, clampMs, nextSpeed, seekTarget } from '@oat/meeting-ui/playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AudioStore, type AudioMetadata, type AudioSource } from './audio-store';

interface LocalAudio {
  userId: string;
  metadata: AudioMetadata;
  urls: Partial<Record<AudioSource, string>>[];
}

export function useOpfsPlayback(userId: string, meetingId: string | null, revision: number) {
  const audioStore = useMemo(() => new AudioStore(userId), [userId]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const secondaryRef = useRef<HTMLAudioElement>(null);
  const [clock] = useState(() => new PlaybackClock());
  const [loaded, setLocal] = useState<LocalAudio | null>(null);
  const local =
    loaded?.userId === userId && loaded.metadata.meetingId === meetingId ? loaded : null;
  const [version, setVersion] = useState(0);
  const [index, setIndex] = useState(0);
  const [preferredSource, setSource] = useState<PlaybackSource>('mix');
  const source = availablePlaybackSource(preferredSource, local?.metadata.parts ?? []);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [seekCount, setSeekCount] = useState(0);
  const wanted = useRef(0);
  const resume = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    const audio = audioRef.current;
    const other = secondaryRef.current;
    const load = async () => {
      const metadata = await (meetingId ? audioStore.load(meetingId) : Promise.resolve(null));
      if (cancelled) return;
      setLocal(null);
      setIndex(0);
      setSource('mix');
      clock.set(0);
      wanted.current = 0;
      resume.current = false;
      if (!metadata || !metadata.parts.length) return;
      const parts = [];
      const sources: LocalAudio['urls'] = [];
      for (const part of metadata.parts) {
        const row: Partial<Record<AudioSource, string>> = {};
        for (const source of part.sources) {
          try {
            const blob = await audioStore.blob(metadata.meetingId, part.part, source);
            if (blob.size && !cancelled) {
              const url = URL.createObjectURL(new Blob([blob], { type: 'audio/webm;codecs=opus' }));
              urls.push(url);
              row[source] = url;
            }
          } catch {
            /* A failed source does not hide other playable audio. */
          }
        }
        if (Object.keys(row).length && part.endMs > part.startMs) {
          parts.push({ ...part, sources: part.sources.filter((source) => !!row[source]) });
          sources.push(row);
        }
      }
      if (!cancelled && parts.length)
        setLocal({ userId, metadata: { ...metadata, parts }, urls: sources });
    };
    void load().catch(() => {});
    return () => {
      cancelled = true;
      audio?.pause();
      other?.pause();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [userId, audioStore, meetingId, revision, version, clock]);

  const part = local?.metadata.parts[index];
  const urls = local?.urls[index];
  const primary = source === 'mix' ? (urls?.mic ?? urls?.system) : urls?.[source];
  const secondary = source === 'mix' && urls?.mic ? urls.system : undefined;
  const pause = useCallback(() => {
    resume.current = false;
    audioRef.current?.pause();
    secondaryRef.current?.pause();
    setPlaying(false);
  }, []);
  const seek = useCallback(
    (value: number) => {
      if (!local) return;
      const eligible = local.metadata.parts.filter(
        (_, i) => source === 'mix' || !!local.urls[i]?.[source],
      );
      if (!eligible.length) return;
      const ms = seekTarget(eligible, value, local.metadata.durationMs);
      let next = local.metadata.parts.findIndex(
        (p) => eligible.includes(p) && p.startMs <= ms && ms < p.endMs,
      );
      if (next < 0) next = local.metadata.parts.indexOf(eligible.at(-1)!);
      wanted.current = ms;
      clock.set(ms);
      setSeekCount((n) => n + 1);
      if (next === index) {
        const offset = Math.max(0, (ms - local.metadata.parts[next]!.startMs) / 1000);
        for (const audio of [audioRef.current, secondaryRef.current])
          if (audio?.getAttribute('src')) audio.currentTime = offset;
      } else {
        resume.current = !audioRef.current?.paused;
        setIndex(next);
        return true;
      }
    },
    [local, index, clock, source],
  );

  useEffect(() => {
    const audio = audioRef.current;
    const other = secondaryRef.current;
    if (!audio || !other || !part) return;
    setPlaying(false);
    let frame = 0;
    const start = async () => {
      try {
        if (secondary) {
          other.currentTime = audio.currentTime;
          await other.play();
        }
        if (resume.current) await audio.play();
      } catch {
        setPlayError('Could not play local audio. Retry playback.');
      }
    };
    const ready = () => {
      audio.currentTime = Math.max(0, (wanted.current - part.startMs) / 1000);
      if (resume.current) void start();
    };
    const tick = () => {
      const ms = clampMs(part.startMs + audio.currentTime * 1000, part.endMs);
      wanted.current = ms;
      clock.set(ms);
      if (secondary && !other.paused && Math.abs(other.currentTime - audio.currentTime) > 0.15)
        other.currentTime = audio.currentTime;
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      resume.current = true;
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
      if (secondary) other.currentTime = audio.currentTime;
      if (secondary)
        void other.play().catch(() => setPlayError('Could not play shared-tab audio.'));
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      other.pause();
    };
    const onEnded = () => {
      onPause();
      const next =
        local?.urls.findIndex((urls, i) => i > index && (source === 'mix' || !!urls[source])) ?? -1;
      if (local && next >= 0) {
        wanted.current = local.metadata.parts[next]!.startMs;
        resume.current = true;
        setIndex(next);
      } else {
        resume.current = false;
        clock.set(part.endMs);
      }
    };
    const onError = () => setPlayError('Could not play local audio. Retry playback.');
    audio.addEventListener('loadedmetadata', ready);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.pause();
    other.pause();
    if (primary) {
      audio.src = primary;
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    if (secondary) {
      other.src = secondary;
    } else {
      other.removeAttribute('src');
      other.load();
    }
    audio.playbackRate = other.playbackRate = speed;
    return () => {
      cancelAnimationFrame(frame);
      audio.pause();
      other.pause();
      audio.removeEventListener('loadedmetadata', ready);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
    // Speed is applied independently without reloading media.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, secondary, part, index, local, clock, source]);
  useEffect(() => {
    for (const audio of [audioRef.current, secondaryRef.current])
      if (audio) audio.playbackRate = speed;
  }, [speed]);
  const info: PlaybackInfo | null = local
    ? {
        meetingId: local.metadata.meetingId,
        status: 'available',
        durationMs: local.metadata.durationMs,
        parts: local.metadata.parts,
        url: primary ?? null,
      }
    : null;
  const player: MeetingPlayback = {
    info,
    available: !!primary,
    clock,
    loadError: null,
    playError,
    playing,
    buffering: false,
    source,
    sourceOptions: (['mic', 'system', 'mix'] as PlaybackSource[]).filter(
      (value) => value === 'mix' || local?.urls.some((urls) => !!urls[value]),
    ),
    speed,
    seekCount,
    seek,
    seekBy: (delta) => seek(clock.ms + delta),
    pause,
    toggle: () => {
      const audio = audioRef.current;
      if (!audio || !primary) return;
      if (!audio.paused) pause();
      else {
        const loadingPart = (audio.ended || clock.ms >= (info?.durationMs ?? 0)) && seek(0);
        resume.current = true;
        if (loadingPart) return;
        void audio.play().catch(() => setPlayError('Could not play local audio. Retry playback.'));
      }
    },
    setSource: (value) => {
      wanted.current = clock.ms;
      resume.current = !audioRef.current?.paused;
      if (local && value !== 'mix' && !local.urls[index]?.[value]) {
        const next = local.urls.findIndex((urls) => !!urls[value]);
        if (next < 0) return;
        wanted.current = local.metadata.parts[next]!.startMs;
        clock.set(wanted.current);
        setIndex(next);
      }
      setSource(value);
    },
    cycleSpeed: () => setSpeed(nextSpeed(speed)),
    retry: () => {
      setPlayError(null);
      setVersion((n) => n + 1);
    },
  };
  const deleteAudio = async () => {
    if (!meetingId) return;
    pause();
    const previous = local;
    setLocal(null);
    try {
      await audioStore.delete(meetingId);
      setVersion((n) => n + 1);
    } catch (error) {
      setLocal(previous);
      throw error;
    }
  };
  return { player, audioRef, secondaryRef, local: !!local, deleteAudio };
}
