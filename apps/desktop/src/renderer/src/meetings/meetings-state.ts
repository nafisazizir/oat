/**
 * Renderer side of the meeting notes (3.4): the list, one opened note and its stored transcript, read from
 * the main process (local database) and reloaded whenever main says they changed (`meetings:changed`:
 * a recording created or ended one, sync pulled changes, attendees changed).
 */
import type {
  MeetingNote,
  MeetingNoteSummary,
  StoredSegment,
  TranscriptBackfillStatus,
} from '@oat/core/bridge';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { bridge, call } from '../bridge.ts';

// --- change counter -------------------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
let subscribed = false;

function subscribe(listener: () => void) {
  if (!subscribed) {
    subscribed = true;
    bridge().subscribe('meetings:changed', () => {
      version++;
      for (const l of listeners) l();
    });
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Bumped every time main announces that meeting notes changed. */
export function useMeetingsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Reload this view's meeting data now (after a local action that main doesn't announce). */
export function bumpMeetingsVersion() {
  version++;
  for (const l of listeners) l();
}

// --- pending edits on quit / unload ------------------------------------------------------------------------

const flushers = new Set<() => Promise<void>>();
let flushWired = false;

function flushAll(): Promise<unknown> {
  return Promise.allSettled([...flushers].map((f) => f()));
}

/**
 * Registers a writer of pending edits (an open note's autosave). They all run when the window goes away
 * (`pagehide`: the save invokes are dispatched before unload) and when main asks before quitting
 * (`notes:flush` → `notes:flushed`, main waits ≤ 1 s).
 */
export function registerFlush(flush: () => Promise<void>): () => void {
  if (!flushWired) {
    flushWired = true;
    window.addEventListener('pagehide', () => void flushAll());
    bridge().subscribe('notes:flush', ({ id }) => {
      void flushAll().then(() => bridge().send('notes:flushed', { id }));
    });
  }
  flushers.add(flush);
  return () => void flushers.delete(flush);
}

// --- hooks ------------------------------------------------------------------------------------------------

/** The meeting notes on this Mac, newest first (`null` until loaded). */
export function useMeetingNotes(enabled: boolean): MeetingNoteSummary[] | null {
  const v = useMeetingsVersion();
  const [notes, setNotes] = useState<MeetingNoteSummary[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    call('meetings:list')
      .then((r) => live && setNotes(r.notes))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, v]);
  return enabled ? notes : null;
}

export interface OpenNote {
  note: MeetingNote | null;
  /** The first load for this document finished. */
  loaded: boolean;
  failure?: 'missing' | 'offline' | 'error';
  retry(): void;
}

/** One note (header, my notes, attendees), reloaded on every change announcement. */
export function useMeetingNote(documentId: string | null): OpenNote {
  const v = useMeetingsVersion();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    id: string | null;
    note: MeetingNote | null;
    failure?: OpenNote['failure'];
  }>({
    id: null,
    note: null,
  });
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    call('meeting:load', { documentId })
      .then(
        (result) =>
          live &&
          setState(
            result.state === 'ready'
              ? { id: documentId, note: result.note }
              : { id: documentId, note: null, failure: result.state },
          ),
      )
      .catch(() => live && setState({ id: documentId, note: null, failure: 'error' }));
    return () => {
      live = false;
    };
  }, [documentId, v, attempt]);
  const current = state.id === documentId;
  return {
    note: current ? state.note : null,
    loaded: current,
    failure: current ? state.failure : undefined,
    retry: () => {
      setState({ id: null, note: null });
      setAttempt((n) => n + 1);
    },
  };
}

export interface StoredTranscript {
  segments: StoredSegment[];
  loaded: boolean;
  failed: boolean;
}

/**
 * The note's stored transcript. While the note is being recorded the live transcript has everything new, so
 * this is loaded once when it opens and not on every change (`refresh: false`).
 */
export function useStoredTranscript(documentId: string | null, refresh: boolean): StoredTranscript {
  const v = useMeetingsVersion();
  const [state, setState] = useState<{ id: string | null; t: StoredTranscript }>({
    id: null,
    t: { segments: [], loaded: false, failed: false },
  });
  const key = refresh ? v : -1;
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    call('meeting:transcript', { documentId })
      .then(
        (r) =>
          live &&
          setState({ id: documentId, t: { segments: r.segments, loaded: true, failed: false } }),
      )
      .catch(
        () => live && setState({ id: documentId, t: { segments: [], loaded: true, failed: true } }),
      );
    return () => {
      live = false;
    };
  }, [documentId, key]);
  return state.id === documentId ? state.t : { segments: [], loaded: !documentId, failed: false };
}

/**
 * Back-fill progress and crash-recovery note of a meeting (2.7), reloaded on every change announcement
 * (main announces job progress and recoveries with `meetings:changed`). `null` until loaded / no meeting.
 */
export function useTranscriptStatus(meetingId: string | null): TranscriptBackfillStatus | null {
  const v = useMeetingsVersion();
  const [state, setState] = useState<TranscriptBackfillStatus | null>(null);
  useEffect(() => {
    if (!meetingId) return;
    let live = true;
    call('meeting:transcript-status', { meetingId })
      .then((s) => live && setState(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [meetingId, v]);
  return meetingId && state?.meetingId === meetingId ? state : null;
}
