'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { pipelineApi } from '@/lib/api-client';
import { isLivePipelineStatus, type PipelineRunResponse } from '@/lib/pipeline';

/** While a run is live, and while there is none yet (a meeting can end while the page is open). */
const POLL_LIVE_MS = 2_000;
const POLL_IDLE_MS = 15_000;

/**
 * Silent watcher for a meeting's post-meeting pipeline (8.3): polls `GET /api/documents/:id/pipeline`
 * while a run is live or the meeting is still going so `onEnhancing` lets the editor follow the live
 * enhancement, and surfaces a toast if a run fails. Renders no header chrome.
 */
export function PipelineStatus({
  documentId,
  canRun: editable,
  onEnhancing,
}: {
  documentId: string;
  /** The note is editable here (not trashed, edit access): may retry on failure. */
  canRun: boolean;
  /** The pipeline is (or was just) enhancing this note. */
  onEnhancing?: () => void;
}) {
  const [state, setState] = useState<PipelineRunResponse | null>(null);
  const enhancing = useRef(onEnhancing);
  const failedRunId = useRef<string | null>(null);
  useEffect(() => {
    enhancing.current = onEnhancing;
  });

  const apply = useCallback((next: PipelineRunResponse) => {
    setState(next);
    const run = next.run;
    if (
      run &&
      (run.currentStep === 'enhance' ||
        run.steps.some((s) => s.step === 'enhance' && s.outcome === 'ran'))
    ) {
      enhancing.current?.();
    }
  }, []);

  /** How soon to look again (`null`: no need). */
  const pollIn = (s: PipelineRunResponse | null): number | null => {
    if (s === null) return POLL_IDLE_MS;
    if (s.run && isLivePipelineStatus(s.run.status)) return POLL_LIVE_MS;
    return s.meetingEnded ? null : POLL_IDLE_MS;
  };
  const mode = pollIn(state);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: PipelineRunResponse | undefined;
      try {
        next = await pipelineApi.run(documentId);
      } catch {
        next = undefined;
      }
      if (cancelled) return;
      if (next) apply(next);
      const delay = next ? pollIn(next) : POLL_IDLE_MS;
      if (delay !== null) timer = setTimeout(tick, delay);
    };
    if (state === null || mode !== null) void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Re-arm only when the polling mode flips (each tick schedules the next itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, mode, apply]);

  const run = state?.run ?? null;
  const mayRun = editable && state?.canRun === true;

  useEffect(() => {
    if (!run || run.status !== 'failed' || failedRunId.current === run.id) return;
    failedRunId.current = run.id;
    toast.error(run.retryable ? 'Post-meeting steps failed' : 'Post-meeting steps couldn’t run', {
      id: `pipeline-failed-${run.id}`,
      description: run.error ?? undefined,
      ...(run.retryable && mayRun
        ? {
            action: {
              label: 'Retry',
              onClick: () => {
                void pipelineApi.start(documentId).then(apply, (error: unknown) => {
                  toast.error('Couldn’t retry', {
                    description: error instanceof Error ? error.message : 'Please try again.',
                  });
                });
              },
            },
          }
        : {}),
    });
  }, [run, mayRun, documentId, apply]);

  return null;
}
