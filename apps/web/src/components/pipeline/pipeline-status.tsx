'use client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { CircleAlertIcon, CircleCheckIcon, Loader2Icon, RotateCcwIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { pipelineApi } from '@/lib/api-client';
import {
  isLivePipelineStatus,
  type PipelineRunResponse,
  type PipelineStepName,
  type PipelineStepRecord,
} from '@/lib/pipeline';

/** While a run is live, and while there is none yet (a meeting can end while the page is open). */
const POLL_LIVE_MS = 2_000;
const POLL_IDLE_MS = 15_000;

const RUNNING: Record<PipelineStepName, string> = {
  enhance: 'enhancing…',
  index: 'indexing…',
  notion: 'sending to Notion…',
};

const STEP_LABEL: Record<PipelineStepName, string> = {
  enhance: 'Enhance',
  index: 'Index & action items',
  notion: 'Notion',
};

function stepLine(s: PipelineStepRecord): string {
  return `${STEP_LABEL[s.step]}: ${s.outcome === 'ran' ? 'done' : `skipped (${s.reason ?? 'nothing to do'})`}`;
}

/**
 * The meeting header's post-meeting status (8.3): "Post-meeting: enhancing… / done / failed — Retry", or "Run
 * post-meeting steps" for an ended meeting that has no run yet (e.g. one that ended before 8.3). Polls
 * `GET /api/documents/:id/pipeline` every 2 s while a run is live (a waiting run is handed over again by that
 * read) and every 15 s while the meeting is still going (it can end, or end again, while the page is open);
 * not at all otherwise. `onEnhancing` lets the editor follow the pipeline's enhancement.
 */
export function PipelineStatus({
  documentId,
  canRun: editable,
  onEnhancing,
}: {
  documentId: string;
  /** The note is editable here (not trashed, edit access): may start / retry. */
  canRun: boolean;
  /** The pipeline is (or was just) enhancing this note. */
  onEnhancing?: () => void;
}) {
  const [state, setState] = useState<PipelineRunResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const enhancing = useRef(onEnhancing);
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
        next = undefined; // keep what we show; try again later
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

  async function start() {
    setStarting(true);
    try {
      apply(await pipelineApi.start(documentId));
    } catch (error) {
      toast.error(run ? 'Couldn’t retry' : 'Couldn’t start', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setStarting(false);
    }
  }

  const startButton = (label: string, testId: string) => (
    <Button
      size="xs"
      variant="outline"
      disabled={starting}
      onClick={() => void start()}
      data-testid={testId}
    >
      {starting ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
      {label}
    </Button>
  );

  if (!run) {
    // An ended meeting without a run (ended before 8.3, or its run was never created): offer to run it.
    return state?.meetingEnded && mayRun ? (
      <span className="flex items-center gap-1.5" data-testid="pipeline-status" data-status="none">
        {startButton('Run post-meeting steps', 'pipeline-run')}
      </span>
    ) : null;
  }

  const details = run.steps.map(stepLine).join('\n');
  return (
    <span
      className="flex items-center gap-1.5"
      data-testid="pipeline-status"
      data-status={run.status}
    >
      {run.status === 'completed' ? (
        <Badge variant="secondary" className="gap-1" title={details || undefined}>
          <CircleCheckIcon />
          Post-meeting: done
        </Badge>
      ) : run.status === 'failed' ? (
        <>
          <Badge variant="destructive" className="gap-1" title={run.error ?? undefined}>
            <CircleAlertIcon />
            {run.retryable ? 'Post-meeting: failed' : 'Post-meeting: can’t run'}
          </Badge>
          {run.retryable && mayRun && startButton('Retry', 'pipeline-retry')}
          {!run.retryable && run.error && (
            <span className="text-xs text-muted-foreground" data-testid="pipeline-error">
              {run.error}
            </span>
          )}
        </>
      ) : (
        <Badge variant="outline" className="gap-1" role="status">
          <Loader2Icon className="animate-spin motion-reduce:animate-none" />
          Post-meeting:{' '}
          {run.status === 'waiting'
            ? 'waiting for the pipeline…'
            : run.status === 'queued' || !run.currentStep
              ? 'starting…'
              : RUNNING[run.currentStep]}
        </Badge>
      )}
    </span>
  );
}
