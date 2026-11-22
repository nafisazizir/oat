'use client';

import type { EnhanceOutput } from '@oat/ai/enhance';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EnhanceEvent,
  EnhancementDto,
  StartEnhanceInput,
  StartEnhanceResult,
} from '@oat/services/dto/enhance';

import { useEnhanceClient, type EnhanceSource } from './enhance-client';
import type { ApplyDocument } from './document-enhancement';

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
 * that is still going when the page loads (after a reload or crash). The typed stream client resumes dropped
 * connections with `lastEventId`; the stream ends after `completed` or `failed`.
 */
export function useEnhancement({
  documentId,
  loadedVersion,
  enabled,
  beforeStart,
  onCompleted,
  prepareApply,
}: {
  documentId: string;
  /** The note version this page rendered (a run that finished after that is picked up on mount). */
  loadedVersion: number;
  /** Meeting notes only. Viewers also follow a run someone else started. */
  enabled: boolean;
  /** Runs before the POST (e.g. flush autosave); return `false` to abort with a message. */
  beforeStart?: () => Promise<boolean>;
  onCompleted: (event: Completed, apply?: ApplyDocument) => void | Promise<void>;
  prepareApply?: () => ApplyDocument;
}) {
  const enhanceClient = useEnhanceClient();
  const [state, setState] = useState<EnhancePhase>({ phase: 'idle' });
  const source = useRef<EnhanceSource | null>(null);
  const lastInput = useRef<Omit<StartEnhanceInput, 'idempotencyKey'>>({});
  const completed = useRef(onCompleted);
  const preparer = useRef(prepareApply);
  useEffect(() => {
    completed.current = onCompleted;
    preparer.current = prepareApply;
  });
  /** Runs this page already followed, and when it mounted (`follow` picks up only later runs). */
  const followed = useRef(new Set<string>());
  const [mountedAt] = useState(() => Date.now());
  const phase = useRef(state.phase);
  useEffect(() => {
    phase.current = state.phase;
  });

  const detach = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  const attach = useCallback(
    (enhancementId: string, prepared?: ApplyDocument) => {
      detach();
      let apply: ApplyDocument | undefined;
      try {
        apply = prepared ?? preparer.current?.();
      } catch (error) {
        setState({
          phase: 'failed',
          enhancementId,
          lost: true,
          message:
            error instanceof Error
              ? error.message
              : 'Save your edits before loading enhanced notes.',
        });
        return;
      }
      followed.current.add(enhancementId);
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
        void Promise.resolve()
          .then(() => completed.current(event, apply))
          .then(
            () => setState({ phase: 'idle' }),
            (error: unknown) =>
              setState({
                phase: 'failed',
                enhancementId,
                lost: true,
                message:
                  error instanceof Error ? error.message : 'Couldn’t load the enhanced notes.',
              }),
          );
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
        // CLOSED = the server refused (e.g. 404); otherwise the stream client is reconnecting.
        silentErrors += 1;
        if (es.readyState === 2 || silentErrors > MAX_SILENT_RECONNECTS) {
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
    [detach, enhanceClient],
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
      let result: StartEnhanceResult;
      try {
        if (beforeStart && !(await beforeStart()))
          throw new Error(
            'Your latest edits aren’t saved yet, so the AI can’t use them. Try again.',
          );
        const apply = prepareApply?.();
        result = await enhanceClient.start(documentId, {
          idempotencyKey: crypto.randomUUID(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...input,
        });
        attach(result.enhancement.id, apply);
      } catch (error) {
        setState({
          phase: 'failed',
          enhancementId: null,
          message: error instanceof Error ? error.message : 'Couldn’t start enhancing. Try again.',
        });
        return;
      }
    },
    [attach, beforeStart, documentId, state.phase, enhanceClient, prepareApply],
  );

  /**
   * Picks up a run started elsewhere while this page is open (8.3: the post-meeting pipeline enhancing the note):
   * follows it live while it generates, or shows its result if it already finished and was applied.
   */
  const follow = useCallback(() => {
    if (!enabled || phase.current === 'starting' || phase.current === 'streaming') return;
    enhanceClient
      .latest(documentId)
      .then(({ latest }) => {
        if (!latest || followed.current.has(latest.id)) return;
        if (phase.current === 'starting' || phase.current === 'streaming') return;
        const finishedSince =
          latest.status === 'completed' &&
          latest.applied === true &&
          latest.completedAt !== null &&
          Date.parse(latest.completedAt) >= mountedAt;
        if (latest.status === 'generating' || finishedSince) attach(latest.id);
      })
      .catch(() => undefined);
  }, [attach, documentId, enabled, mountedAt, enhanceClient]);

  /** Follow the same run again (after a lost connection). */
  const reattach = useCallback(() => {
    if (state.phase === 'failed' && state.enhancementId) attach(state.enhancementId);
  }, [attach, state]);

  /** Start again with the same template. */
  const retry = useCallback(() => void start(lastInput.current), [start]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);

  return { state, start, retry, reattach, dismiss, follow };
}

export type Enhancement = ReturnType<typeof useEnhancement>;
export type { EnhancementDto };
