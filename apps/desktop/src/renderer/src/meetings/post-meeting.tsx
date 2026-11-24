/**
 * Silent watcher for a meeting's post-meeting pipeline (7.5 / 8.3) on desktop: polls `pipeline:get` while a
 * run is live or expected, and surfaces a toast with Retry if the run fails. Renders no header chrome.
 */
import type { PipelineStatus } from '@oat/core/bridge';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { isLivePipeline } from '../auto-stop/auto-stop-state.ts';
import { BridgeCallError, call } from '../bridge.ts';

const POLL_LIVE_MS = 2_000;
const POLL_IDLE_MS = 15_000;
/** Right after the meeting ended a run is about to appear: look often. */
const EXPECT_RUN_FOR_MS = 2 * 60_000;
/** After that, a note without a run is looked at this many more times (15 s apart), then left alone. */
const IDLE_TRIES = 4;

export function PipelineWatcher({
  documentId,
  endedAt,
}: {
  documentId: string;
  /** The meeting's end on this Mac (ISO). */
  endedAt: string;
}) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [tick, setTick] = useState(0);
  /** Reads in a row that found no run (or failed). */
  const [misses, setMisses] = useState(0);
  const failedShown = useRef(false);

  const run = status?.run ?? null;

  useEffect(() => {
    let live = true;
    void call('pipeline:get', { documentId })
      .then((next) => {
        if (!live) return;
        setStatus(next);
        setMisses((m) => (next.run ? 0 : m + 1));
      })
      // Offline / not on the server yet: keep what we have.
      .catch(() => live && setMisses((m) => m + 1));
    return () => {
      live = false;
    };
  }, [documentId, tick]);

  const live = isLivePipeline(run);
  const none = run === null;
  useEffect(() => {
    const justEnded = Date.now() - Date.parse(endedAt) < EXPECT_RUN_FOR_MS;
    const delay =
      live || (none && justEnded)
        ? POLL_LIVE_MS
        : none && misses <= IDLE_TRIES
          ? POLL_IDLE_MS
          : null;
    if (delay === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), delay);
    return () => clearTimeout(timer);
  }, [live, none, endedAt, misses, tick]);

  useEffect(() => {
    if (!run || run.status !== 'failed') {
      failedShown.current = false;
      return;
    }
    if (failedShown.current) return;
    failedShown.current = true;
    toast.error(run.retryable ? 'Post-meeting steps failed' : 'Post-meeting steps couldn’t run', {
      id: `pipeline-failed-${documentId}`,
      description: run.error ?? undefined,
      ...(run.retryable && status?.canRun
        ? {
            action: {
              label: 'Retry',
              onClick: () => {
                failedShown.current = false;
                void call('pipeline:retry', { documentId }).then(
                  (next) => {
                    setStatus(next);
                    setTick((t) => t + 1);
                  },
                  (e: unknown) => {
                    toast.error('Couldn’t retry', {
                      description: e instanceof BridgeCallError ? e.message : 'Please try again.',
                    });
                  },
                );
              },
            },
          }
        : {}),
    });
  }, [run, status?.canRun, documentId]);

  return null;
}
