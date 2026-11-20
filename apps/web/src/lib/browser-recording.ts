import type { SyncPushResponse, SyncMeetingPush } from '@oat/core/sync';
import { updateLiveTranscript } from '@oat/meeting-ui/live-transcript';
import { BrowserSttStream, type SttSegment, type AudioFrame } from '@oat/stt/browser';

import { meetingApi } from './meeting';
import { pcmWorkletModule } from './recording-pcm';
import { RecordingQueue, hasSyncBacklog } from './recording-queue';
import { audioStore, BrowserAudioArchive } from './audio-store';

export interface RecordingState {
  documentId: string | null;
  status: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'ended';
  elapsed: number;
  segments: SttSegment[];
  error: string | null;
  notice: string | null;
  pending: number;
  syncError: string | null;
  pendingSince: number | null;
  meetingId: string | null;
  audioNotice: string | null;
  changing: boolean;
  syncDelayed: boolean;
}
const initial: RecordingState = {
  documentId: null,
  status: 'idle',
  elapsed: 0,
  segments: [],
  error: null,
  notice: null,
  pending: 0,
  syncError: null,
  pendingSince: null,
  meetingId: null,
  audioNotice: null,
  changing: false,
  syncDelayed: false,
};
const active = (state: RecordingState) => !['idle', 'ended'].includes(state.status);
export function supportsRecording() {
  return (
    typeof window !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined'
  );
}
export async function recordingPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      `Recording request failed (${response.status}). Check your connection and permissions, then retry.`,
    );
  return response.json() as Promise<T>;
}

export class BrowserRecording {
  #state = initial;
  #listeners = new Set<() => void>();
  #context: AudioContext | undefined;
  #media: MediaStream[] = [];
  #nodes: AudioNode[] = [];
  #streams: BrowserSttStream[] = [];
  #queue = new RecordingQueue(
    (entries) =>
      recordingPost<SyncPushResponse>('/api/sync/push', { entries, device: { name: 'Browser' } }),
    (pending, syncError) =>
      this.#set({
        pending,
        syncError,
        pendingSince: pending ? (this.#state.pendingSince ?? Date.now()) : null,
        syncDelayed: pending ? this.#state.syncDelayed : false,
      }),
  );
  #meeting: SyncMeetingPush | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #tab = false;
  #archive: BrowserAudioArchive | undefined;
  #clockStart = 0;
  #clockMs = () =>
    Math.max(0, ((this.#context?.currentTime ?? this.#clockStart) - this.#clockStart) * 1000);
  snapshot = () => this.#state;
  serverSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #set(patch: Partial<RecordingState>) {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
  #warn = (event: BeforeUnloadEvent) => {
    if (active(this.#state) || this.#queue.pending) {
      event.preventDefault();
      event.returnValue = '';
    }
  };

  async start(documentId: string, tab: boolean) {
    if (active(this.#state) || this.#queue.pending) return;
    clearInterval(this.#timer);
    this.#state = { ...initial, documentId, status: 'starting' };
    this.#set({});
    this.#tab = tab;
    window.addEventListener('beforeunload', this.#warn);
    try {
      if (tab) {
        const shared = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        this.#media.push(shared);
        shared.getVideoTracks().forEach((track) => track.stop());
        if (!shared.getAudioTracks().length)
          throw new Error('Choose a browser tab and tick “Share tab audio”, then retry.');
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.#media.unshift(mic);
      const info = await meetingApi.get(documentId, { recording: true, transcript: true });
      if (info.endedAt && info.transcript?.length)
        throw new Error(
          'This meeting already has a finished transcript. Create a new note to record.',
        );
      if (info.startedAt && !info.endedAt)
        throw new Error(
          'This meeting may already be recording on another device. Stop it there first.',
        );
      const context = new AudioContext();
      this.#context = context;
      await context.resume();
      const url = URL.createObjectURL(new Blob([pcmWorkletModule()], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const clockStart = context.currentTime;
      this.#clockStart = clockStart;
      this.#meeting = {
        id: info.meetingId ?? crypto.randomUUID(),
        documentId,
        startedAt: new Date().toISOString(),
        endedAt: null,
        calendarEventId: info.recording?.calendarEventId ?? null,
        platform: 'browser',
      };
      this.#set({ meetingId: this.#meeting.id });
      this.#archive = new BrowserAudioArchive(audioStore, this.#meeting.id, (audioNotice) =>
        this.#set({ audioNotice }),
      );
      await this.#archive.start(
        this.#clockMs(),
        this.#media.map((stream, index) => ({ stream, source: index === 0 ? 'mic' : 'system' })),
      );
      for (const [index, media] of this.#media.entries()) {
        const source = index === 0 ? 'mic' : 'system';
        const stream = new BrowserSttStream({
          source,
          sampleRate: 16000,
          getToken: () => recordingPost('/api/stt/token'),
        });
        this.#streams.push(stream);
        stream.on('error', (error) => this.#set({ error: error.message }));
        stream.on('status', (status) => {
          if (status === 'open' && this.#streams.every((s) => s.status === 'open'))
            this.#set({ error: null });
        });
        stream.on('segment', (segment) => {
          const segments = updateLiveTranscript(this.#state.segments, segment);
          this.#set({ segments });
          if (segment.isFinal) {
            if (!segment.text)
              this.#queue.enqueue({ op: 'delete', table: 'transcript_segment', id: segment.id });
            else
              this.#queue.enqueue({
                op: 'upsert',
                table: 'transcript_segment',
                row: {
                  id: segment.id,
                  meetingId: this.#meeting!.id,
                  source,
                  speakerLabel: null,
                  startMs: segment.startMs,
                  endMs: segment.endMs,
                  text: segment.text,
                },
              });
          }
        });
        const input = context.createMediaStreamSource(new MediaStream(media.getAudioTracks()));
        const worklet = new AudioWorkletNode(context, 'oat-pcm');
        worklet.port.onmessage = ({ data }: MessageEvent<{ pcm: Int16Array; tUs: number }>) => {
          if (this.#state.status === 'recording')
            stream.write({
              source,
              sampleRate: 16000,
              ...data,
              tUs: Math.max(0, data.tUs - Math.round(clockStart * 1000000)),
            } satisfies AudioFrame);
        };
        const mute = context.createGain();
        mute.gain.value = 0;
        input.connect(worklet).connect(mute).connect(context.destination);
        this.#nodes.push(input, worklet, mute);
        for (const track of media.getAudioTracks())
          track.addEventListener(
            'ended',
            () =>
              this.#set(
                source === 'system'
                  ? { notice: 'Tab sharing stopped. Your microphone is still recording.' }
                  : {
                      error:
                        'The microphone stopped. Stop this recording and retry with a working microphone.',
                    },
              ),
            { once: true },
          );
      }
      this.#queue.enqueue({ op: 'upsert', table: 'meeting', row: this.#meeting });
      this.#set({ status: 'recording' });
      void this.#queue.flush();
      this.#timer = setInterval(() => {
        this.#set({
          elapsed: Math.max(0, context.currentTime - clockStart),
          syncDelayed: hasSyncBacklog(this.#state.pendingSince, Date.now()),
        });
        void this.#queue.flush();
        if (!active(this.#state) && !this.#queue.pending) {
          clearInterval(this.#timer);
          window.removeEventListener('beforeunload', this.#warn);
        }
      }, 1000);
    } catch (error) {
      await this.#archive?.end(this.#clockMs(), true);
      this.#archive = undefined;
      this.#release();
      this.#streams.forEach((stream) => stream.close());
      this.#streams = [];
      this.#set({
        status: 'idle',
        error:
          error instanceof Error
            ? error.message
            : 'Recording could not start. Check microphone permission and retry.',
      });
      window.removeEventListener('beforeunload', this.#warn);
    }
  }

  async pause() {
    if (this.#state.changing) return;
    this.#set({ changing: true });
    try {
      if (this.#state.status === 'recording') {
        this.#set({ status: 'paused' });
        await this.#context?.suspend();
        await this.#archive?.end(this.#clockMs(), false);
      } else if (this.#state.status === 'paused') {
        await this.#archive?.start(
          this.#clockMs(),
          this.#media.map((stream, index) => ({ stream, source: index === 0 ? 'mic' : 'system' })),
        );
        await this.#context?.resume();
        this.#set({ status: 'recording' });
      }
    } catch {
      this.#set({ error: 'Could not change microphone capture. Stop and retry recording.' });
    } finally {
      this.#set({ changing: false });
    }
  }
  #release() {
    this.#media.forEach((media) => media.getTracks().forEach((track) => track.stop()));
    this.#media = [];
    this.#nodes.forEach((node) => node.disconnect());
    this.#nodes = [];
    const context = this.#context;
    this.#context = undefined;
    void context?.close().catch(() => {});
  }
  async stop() {
    if (this.#state.changing || !['recording', 'paused'].includes(this.#state.status)) return;
    const endedAt = new Date().toISOString();
    const endMs = this.#clockMs();
    this.#set({ status: 'stopping' });
    await this.#context?.suspend().catch(() => {});
    await this.#archive?.end(endMs, true);
    this.#archive = undefined;
    this.#release();
    await Promise.all(this.#streams.map((stream) => stream.finish()));
    this.#streams = [];
    if (this.#meeting)
      this.#queue.enqueue({
        op: 'upsert',
        table: 'meeting',
        row: { ...this.#meeting, endedAt },
      });
    await this.#queue.flush();
    this.#set({ status: 'ended' });
  }
  retry() {
    if (this.#state.status === 'idle' && this.#state.documentId)
      void this.start(this.#state.documentId, this.#tab);
    else {
      this.#streams
        .filter((stream) => stream.status !== 'open')
        .forEach((stream) => stream.retry());
      void this.#queue.flush();
    }
  }
}

export const browserRecording = new BrowserRecording();
