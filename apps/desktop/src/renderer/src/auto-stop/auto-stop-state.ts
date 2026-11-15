/**
 * Renderer side of auto-stop + the post-stop grace period (7.5): what main pushes on `autostop:changed` and
 * `grace:changed`. Subscribes before asking, like `calendar-state.ts`, so a push in between isn't lost.
 */
import type { AutoStopNoticeSnapshot, MeetingGrace, PipelineStatus } from '@oat/core/bridge';
import { useEffect, useState } from 'react';

import { bridge, call } from '../bridge.ts';

/** The "Stopping…" toast or the "Meeting over?" question main shows, if any. */
export function useAutoStopNotice(): AutoStopNoticeSnapshot | null {
  const [notice, setNotice] = useState<AutoStopNoticeSnapshot | null>(null);
  useEffect(() => {
    let pushed = false;
    const unsubscribe = bridge().subscribe('autostop:changed', ({ notice: next }) => {
      pushed = true;
      setNotice(next);
    });
    void call('autostop:get')
      .then((current) => {
        if (!pushed) setNotice(current);
      })
      .catch(() => {});
    return unsubscribe;
  }, []);
  return notice;
}

/** The stopped meeting in its grace period, if any. */
export function useMeetingGrace(): MeetingGrace | null {
  const [grace, setGrace] = useState<MeetingGrace | null>(null);
  useEffect(() => {
    let pushed = false;
    const unsubscribe = bridge().subscribe('grace:changed', ({ grace: next }) => {
      pushed = true;
      setGrace(next);
    });
    void call('grace:get')
      .then((current) => {
        if (!pushed) setGrace(current);
      })
      .catch(() => {});
    return unsubscribe;
  }, []);
  return grace;
}

/** Whole seconds left until `at` (≥ 0), re-rendering every second while counting. */
export function useSecondsLeft(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export type PipelineRun = NonNullable<PipelineStatus['run']>;

const RUNNING: Record<NonNullable<PipelineRun['currentStep']>, string> = {
  enhance: 'enhancing…',
  index: 'indexing…',
  notion: 'sending to Notion…',
};

/** "Post-meeting: …" text for a run. */
export function pipelineLabel(run: PipelineRun): string {
  switch (run.status) {
    case 'waiting':
      return 'waiting for the pipeline…';
    case 'queued':
      return 'starting…';
    case 'running':
      return run.currentStep ? RUNNING[run.currentStep] : 'running…';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

/** Why the notes weren't enhanced, when the run skipped that step for a reason the user should know. */
export function enhanceSkipped(run: PipelineRun): string | null {
  const step = run.steps.find((s) => s.step === 'enhance' && s.outcome === 'skipped');
  if (step?.reason === 'transcript too short') return 'Not enhanced: the transcript is too short.';
  if (step?.reason === 'auto-enhance off') return 'Not enhanced: auto-enhance is off.';
  return null;
}

export const isLivePipeline = (run: PipelineRun | null) =>
  run !== null && (run.status === 'waiting' || run.status === 'queued' || run.status === 'running');
