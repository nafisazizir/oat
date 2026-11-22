/**
 * The meeting header's post-meeting line (7.5), after a recording stops:
 * - during the grace period: "Post-meeting steps in 45 s" and "Start now" (the recording bar's "Continue
 *   recording" resumes this meeting: the end is never written, so no run starts);
 * - then the post-meeting pipeline (8.3) as the web header shows it: "Post-meeting: enhancing… / done / failed —
 *   Retry", read through main (`pipeline:get`, the web API with the desktop's session). Polled every 2 s while a
 *   run is live or expected (the meeting just ended: the sync push that starts it may still be on its way), then
 *   a few more times every 15 s while there is none (an old or unsynced note: then it stops), not at all once it
 *   finished. Offline / not synced yet: nothing is shown.
 */
import type { PipelineStatus } from '@oat/core/bridge';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle, IconCircleCheck, IconHourglass, IconRotate } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  enhanceSkipped,
  isLivePipeline,
  pipelineLabel,
  useSecondsLeft,
} from '../auto-stop/auto-stop-state.ts';
import { BridgeCallError, call } from '../bridge.ts';

const POLL_LIVE_MS = 2_000;
const POLL_IDLE_MS = 15_000;
/** Right after the meeting ended a run is about to appear: look often. */
const EXPECT_RUN_FOR_MS = 2 * 60_000;
/** After that, a note without a run is looked at this many more times (15 s apart), then left alone. */
const IDLE_TRIES = 4;

/** "Post-meeting steps in 45 s · Start now" (continuing is the recording bar's "Continue recording"). */
export function GraceLine({
  dueAt,
  onFinishNow,
}: {
  dueAt: number;
  onFinishNow: () => Promise<unknown>;
}) {
  const seconds = useSecondsLeft(dueAt) ?? 0;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="meeting-grace">
      <Badge variant="outline" className="gap-1">
        <IconHourglass />
        Post-meeting steps in <span className="tabular-nums">{seconds}</span> s
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void onFinishNow()
            .catch((e: unknown) =>
              setError(e instanceof BridgeCallError ? e.message : 'Something went wrong.'),
            )
            .finally(() => setPending(false));
        }}
      >
        Start now
      </Button>
      {error && (
        <span role="alert" className="text-red-900">
          {error}
        </span>
      )}
    </span>
  );
}

export function PipelineLine({
  documentId,
  endedAt,
}: {
  documentId: string;
  /** The meeting's end on this Mac (ISO). */
  endedAt: string;
}) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Reads in a row that found no run (or failed). */
  const [misses, setMisses] = useState(0);

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

  // How soon to look again: often while a run is live or about to appear, rarely while there is none.
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

  if (!run) return null;
  const failed = run.status === 'failed';
  const done = run.status === 'completed';
  const skipped = done ? enhanceSkipped(run) : null;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-testid="pipeline-status"
      data-status={run.status}
      data-step={run.currentStep ?? ''}
    >
      <Badge variant={failed ? 'destructive' : 'outline'} className="gap-1" aria-live="polite">
        {failed ? (
          <IconAlertCircle />
        ) : done ? (
          <IconCircleCheck className="text-green-900" />
        ) : (
          <Spinner aria-hidden />
        )}
        Post-meeting: {pipelineLabel(run)}
      </Badge>
      {skipped && <span>{skipped}</span>}
      {failed && run.error && <span className="text-red-900">{run.error}</span>}
      {failed && run.retryable && status?.canRun && (
        <Button
          variant="ghost"
          size="sm"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            setError(null);
            void call('pipeline:retry', { documentId })
              .then(setStatus)
              .catch((e: unknown) =>
                setError(e instanceof BridgeCallError ? e.message : 'Couldn’t retry.'),
              )
              .finally(() => setRetrying(false));
          }}
        >
          <IconRotate data-icon="inline-start" />
          Retry
        </Button>
      )}
      {error && (
        <span role="alert" className="text-red-900">
          {error}
        </span>
      )}
    </span>
  );
}
