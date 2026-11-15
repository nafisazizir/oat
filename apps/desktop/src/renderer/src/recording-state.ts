/**
 * Renderer side of recording (2.5): the detailed recording state and the live transcript, one client of
 * each per window, read with `useRecording()` / `useTranscript()`.
 *
 * Both subscribe **before** asking main for a snapshot, like `main-state.ts`:
 * - recording: keep the higher `seq` (a reply may carry the same `seq` as the last push but newer data);
 * - transcript: batches that arrive before the `transcript:get` reply are held, then the ones newer than
 *   the snapshot are applied in order. A batch for another meeting with `seq` 1 starts that meeting's
 *   transcript; any gap (a missed batch) reloads the snapshot.
 */
import type {
  OatBridge,
  RecordingSnapshot,
  TranscriptBatch,
  LiveSegment,
  TranscriptSnapshot,
} from '@oat/core/bridge';
import { useSyncExternalStore } from 'react';

import { TranscriptStore } from '../../shared/transcript.ts';
import { bridge } from './bridge.ts';

type Bridge = Pick<OatBridge, 'invoke' | 'subscribe'>;

interface ExternalStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function listeners() {
  const set = new Set<() => void>();
  return {
    add(listener: () => void) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit() {
      for (const l of set) l();
    },
  };
}

// --- recording state --------------------------------------------------------------------------------

export interface RecordingClient extends ExternalStore<RecordingSnapshot | null> {
  ready: Promise<void>;
}

export function createRecordingClient(oat: Bridge): RecordingClient {
  let current: RecordingSnapshot | null = null;
  const subs = listeners();
  const apply = (next: RecordingSnapshot, fromReply: boolean) => {
    if (current && (next.seq < current.seq || (next.seq === current.seq && !fromReply))) return;
    current = next;
    subs.emit();
  };
  const dispose = oat.subscribe('recording:state', (s) => apply(s, false));
  const ready = oat.invoke('recording:get').then((result) => {
    if (result.ok) apply(result.value, true);
  });
  return { getSnapshot: () => current, subscribe: subs.add, dispose, ready };
}

// --- transcript ---------------------------------------------------------------------------------------

export interface TranscriptView {
  meetingId: string | null;
  /** Time-ordered live segments (replaced, never mutated, on change). */
  segments: readonly LiveSegment[];
  /** `false` until the first snapshot arrived. */
  loaded: boolean;
  /** The last `transcript:get` failed; it is retried with backoff. */
  failed: boolean;
}

export interface TranscriptClient extends ExternalStore<TranscriptView> {
  /** Resolves when the current (re)load finished. */
  ready(): Promise<void>;
}

/** Retry delays after a failed `transcript:get`: 0.5 s, 1 s, 2 s, … capped at 10 s. */
export function retryDelay(failures: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, failures - 1));
}

export function createTranscriptClient(
  oat: Bridge,
  setTimer: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms),
): TranscriptClient {
  const store = new TranscriptStore();
  const subs = listeners();
  let meetingId: string | null = null;
  let seq = 0;
  let loading: Promise<void> | null = null;
  let held: TranscriptBatch[] = [];
  let failures = 0;
  let retryScheduled = false;
  let view: TranscriptView = { meetingId: null, segments: [], loaded: false, failed: false };

  const publish = () => {
    view = { meetingId, segments: store.segments, loaded: true, failed: false };
    subs.emit();
  };

  const reset = (snapshot: TranscriptSnapshot) => {
    store.clear();
    store.apply(snapshot.segments);
    meetingId = snapshot.meetingId;
    seq = snapshot.seq;
  };

  /** Applies one batch; returns false when it can't (gap or unknown meeting) and a reload is needed. */
  const applyBatch = (batch: TranscriptBatch): boolean => {
    if (batch.meetingId !== meetingId) {
      if (batch.seq !== 1) return false;
      store.clear();
      meetingId = batch.meetingId;
      seq = 0;
    }
    if (batch.seq <= seq) return true; // already in the snapshot
    if (batch.seq !== seq + 1) return false;
    store.apply(batch.segments);
    seq = batch.seq;
    return true;
  };

  const load = (): Promise<void> => {
    loading ??= oat
      .invoke('transcript:get')
      .then((result) => {
        if (!result.ok) throw new Error(result.error.message);
        failures = 0;
        reset(result.value);
        const pending = held;
        held = [];
        for (const batch of pending) {
          if (batch.meetingId === meetingId || batch.seq === 1) applyBatch(batch);
        }
        publish();
      })
      .catch(() => {
        failures += 1;
        view = { ...view, failed: true };
        subs.emit();
        if (!retryScheduled) {
          retryScheduled = true;
          setTimer(() => {
            retryScheduled = false;
            void load();
          }, retryDelay(failures));
        }
      })
      .finally(() => (loading = null));
    return loading;
  };

  const dispose = oat.subscribe('transcript:segments', (batch) => {
    if (loading) {
      held.push(batch);
      return;
    }
    if (applyBatch(batch)) publish();
    else {
      held.push(batch);
      void load();
    }
  });
  void load();

  return {
    getSnapshot: () => view,
    subscribe: subs.add,
    dispose,
    ready: () => loading ?? Promise.resolve(),
  };
}

// --- hooks --------------------------------------------------------------------------------------------

let recordingClient: RecordingClient | null = null;
let transcriptClient: TranscriptClient | null = null;

export function useRecording(): RecordingSnapshot | null {
  recordingClient ??= createRecordingClient(bridge());
  return useSyncExternalStore(recordingClient.subscribe, recordingClient.getSnapshot);
}

export function useTranscript(): TranscriptView {
  transcriptClient ??= createTranscriptClient(bridge());
  return useSyncExternalStore(transcriptClient.subscribe, transcriptClient.getSnapshot);
}
