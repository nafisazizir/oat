'use client';

import type { EnhanceOutput } from '@oat/ai/enhance';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api-client';
import type {
  EnhanceEvent,
  EnhancementDto,
  StartEnhanceInput,
  StartEnhanceResult,
} from '@/lib/enhance';

import { enhanceClient } from './client';

export type EnhancePhase =
  | { phase: 'idle' }
  /** Saving pending edits and asking the server to start. */
  | { phase: 'starting' }
  /** The AI is writing: `preview` is the output so far (null until the first event). */
  | { phase: 'streaming'; enhancementId: string; preview: EnhanceOutput | null }
  /** `lost`: the run may still be going, follow it again; otherwise start a new one. */
  | { phase: 'failed'; message: string; enhancementId: string | null; lost?: boolean };

type Completed = Extract<EnhanceEvent, { type: 'completed' }>;

/** After this many reconnects without any event, the stream is reported as lost (with a retry). */
const MAX_SILENT_RECONNECTS = 5;

/**
 * Client side of an enhancement run: starts one (`start`), follows its SSE stream, and re-attaches to a run
 * that is still going when the page loads (after a reload or crash). `EventSource` resumes dropped connections
 * by itself with `Last-Event-ID`; the stream ends after `completed` or `failed`.
 */
export function useEnhancement({
  documentId,
  loadedVersion,
  enabled,
  beforeStart,
  onCompleted,
}: {
  documentId: string;
  /** The note version this page rendered (a run that finished after that is picked up on mount). */
  loadedVersion: number;
  /** Meeting notes only. Viewers also follow a run someone else started. */
  enabled: boolean;
  /** Runs before the POST (e.g. flush autosave); return `false` to abort with a message. */
  beforeStart?: () => Promise<boolean>;
  onCompleted: (event: Completed) => void;
}) {
  const [state, setState] = useState<EnhancePhase>({ phase: 'idle' });
  const source = useRef<EventSource | null>(null);
  const lastInput = useRef<Omit<StartEnhanceInput, 'idempotencyKey'>>({});
  const completed = useRef(onCompleted);
  useEffect(() => {
    completed.current = onCompleted;
  });

  const detach = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  const attach = useCallback(
    (enhancementId: string) => {
      detach();
      setState({ phase: 'streaming', enhancementId, preview: null });
      const es = enhanceClient.stream(enhancementId);
      source.current = es;
      let silentErrors = 0;
      es.addEventListener('preview', (e) => {
        silentErrors = 0;
        const event = JSON.parse((e as MessageEvent<string>).data) as EnhanceEvent;
        if (event.type !== 'preview') return;
        setState((s) =>
          s.phase === 'streaming' && s.enhancementId === enhancementId
            ? { ...s, preview: event.output }
            : s,
        );
      });
      es.addEventListener('completed', (e) => {
        const event = JSON.parse((e as MessageEvent<string>).data) as EnhanceEvent;
        if (event.type !== 'completed') return;
        es.close();
        if (source.current === es) source.current = null;
        setState({ phase: 'idle' });
        completed.current(event);
      });
      es.addEventListener('failed', (e) => {
        const event = JSON.parse((e as MessageEvent<string>).data) as EnhanceEvent;
        es.close();
        if (source.current === es) source.current = null;
        setState({
          phase: 'failed',
          enhancementId,
          message:
            (event.type === 'failed' && event.enhancement.error?.message) ||
            'Enhancing failed. Try again.',
        });
      });
      es.onerror = () => {
        // CLOSED = the server refused (e.g. 404); otherwise the browser is already reconnecting.
        silentErrors += 1;
        if (es.readyState === EventSource.CLOSED || silentErrors > MAX_SILENT_RECONNECTS) {
          es.close();
          if (source.current === es) source.current = null;
          setState({
            phase: 'failed',
            enhancementId,
            lost: true,
            message: 'Lost the connection while the AI was writing.',
          });
        }
      };
    },
    [detach],
  );

  // Re-attach to a run that is still going (reload, another tab, a crash).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    enhanceClient
      .latest(documentId)
      .then(({ latest }) => {
        if (cancelled || !latest) return;
        // Still running, or finished (and applied) between rendering this page and now: follow it, the
        // stream answers a finished run with its result right away.
        const missed =
          latest.status === 'completed' &&
          latest.applied === true &&
          (latest.documentVersion ?? 0) > loadedVersion;
        if (latest.status === 'generating' || missed) attach(latest.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      detach();
    };
    // Only on mount / another note: `loadedVersion` is the version this page was rendered at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, documentId, attach, detach]);

  const start = useCallback(
    async (input: Omit<StartEnhanceInput, 'idempotencyKey'> = {}) => {
      if (state.phase === 'starting' || state.phase === 'streaming') return;
      lastInput.current = input;
      setState({ phase: 'starting' });
      if (beforeStart && !(await beforeStart())) {
        setState({
          phase: 'failed',
          enhancementId: null,
          message: 'Your latest edits aren’t saved yet, so the AI can’t use them. Try again.',
        });
        return;
      }
      let result: StartEnhanceResult;
      try {
        result = await enhanceClient.start(documentId, {
          idempotencyKey: crypto.randomUUID(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...input,
        });
      } catch (error) {
        setState({
          phase: 'failed',
          enhancementId: null,
          message: isApiError(error) ? error.message : 'Couldn’t start enhancing. Try again.',
        });
        return;
      }
      attach(result.enhancement.id);
    },
    [attach, beforeStart, documentId, state.phase],
  );

  /** Follow the same run again (after a lost connection). */
  const reattach = useCallback(() => {
    if (state.phase === 'failed' && state.enhancementId) attach(state.enhancementId);
  }, [attach, state]);

  /** Start again with the same template. */
  const retry = useCallback(() => void start(lastInput.current), [start]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, start, retry, reattach, dismiss };
}

export type Enhancement = ReturnType<typeof useEnhancement>;
export type { EnhancementDto };
