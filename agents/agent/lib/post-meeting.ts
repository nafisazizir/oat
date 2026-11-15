/**
 * The post-meeting pipeline as a durable eve workflow (8.2 spike → 8.3 production wiring, D-29):
 *
 *   load meeting (in the caller's workspace, current attempt) → (1) enhance unless done or switched off →
 *   (2) index the notes + action items → [durable wait] → (3) Notion auto-send → record the outcome
 *
 * Started by the jobs route / the backstop sweep (`start-job.ts`) for one `pipeline_run` attempt. Every step
 * records itself on that row (`@oat/services/pipeline`: current step, then its result; writes fenced on the
 * attempt), which is what the meeting header shows.
 *
 * The body is replayed after every wait, crash or redeploy, so it only orchestrates; each `"use step"`
 * function runs once, and its result is recorded by the Workflow world and replayed afterwards. Steps are
 * thin wrappers over the plain functions in `src/post-meeting/steps.ts`:
 *
 * - "busy" (another run of the note is live, a push holds the lease) is a *result*, not an error: the body
 *   sleeps (durable, holds no compute) and calls the step again until `busyDeadlineMs` — beyond D-26's
 *   staleness, so even our own run orphaned by a crash mid-generation is settled and replaced — then fails
 *   with a clear message. Errors would spend the step's retry budget (3 retries) within seconds.
 * - A missing meeting, one outside the caller's workspace, or a superseded attempt → `FatalError` (no retries).
 * - Anything else → the step's normal retries with backoff; once exhausted the run fails (retry from the UI).
 */
import { OWNER_NO_ACCESS } from '@oat/services/dto/pipeline';
import { finishPipelineRun, isCurrentAttempt, type PipelineRunRef } from '@oat/services/pipeline';
import { FatalError, getWorkflowMetadata, sleep } from 'eve/workflow';

import { stepContext } from '../../src/post-meeting/context.ts';
import {
  ensureEnhanced,
  indexNotes,
  loadMeeting,
  pushToNotion,
} from '../../src/post-meeting/steps.ts';
import { tracked } from '../../src/post-meeting/track.ts';
import {
  type Busy,
  isBusy,
  MeetingNotFound,
  type MeetingRef,
  OwnerNoAccess,
  type PostMeetingInput,
  type PostMeetingRun,
  type StepOutcome,
  type StepRecord,
} from '../../src/post-meeting/types.ts';

export async function postMeetingWorkflow(input: PostMeetingInput): Promise<PostMeetingRun> {
  'use workflow';
  const meta = getWorkflowMetadata();
  const ref: PipelineRunRef = { pipelineRunId: input.pipelineRunId, attempt: input.attempt };
  const steps: StepRecord[] = [];
  let meetingRef: MeetingRef | undefined;
  const run = (
    status: PostMeetingRun['status'],
    error?: string,
  ): Omit<PostMeetingRun, 'finishedAt'> => ({
    runId: meta.workflowRunId,
    pipelineRunId: input.pipelineRunId,
    attempt: input.attempt,
    meetingId: input.meetingId,
    documentId: meetingRef?.documentId ?? null,
    status,
    startedAt: new Date(meta.workflowStartedAt).toISOString(),
    steps,
    ...(error ? { error } : {}),
  });
  try {
    const m = await loadMeetingStep(input);
    meetingRef = m;
    steps.push(await untilNotBusy((since) => enhanceStep(ref, m, meta.workflowRunId, since)));
    steps.push(await indexStep(ref, m));
    if (input.pushDelayMs && input.pushDelayMs > 0) await sleep(input.pushDelayMs);
    steps.push(await untilNotBusy((since) => notionStep(ref, m, since)));
    // Inside the try: if recording the success fails for good, the run is recorded as failed (and if even
    // that fails, the stuck-run sweep settles the row from the world's record).
    return await finishStep(ref, run('completed'));
  } catch (error) {
    await finishStep(ref, run('failed', error instanceof Error ? error.message : String(error)));
    throw error;
  }
}

/** Errors no retry of the step can fix end the run at once (`FatalError`); the rest get the step's retries. */
function fatal(error: unknown): unknown {
  if (error instanceof OwnerNoAccess) return new FatalError(`${OWNER_NO_ACCESS}: ${error.message}`);
  if (error instanceof MeetingNotFound) return new FatalError(error.message);
  return error;
}

/**
 * Calls a step until it isn't busy, sleeping durably in between; fails once the deadline has passed since the
 * first busy answer. Times come from the steps' recorded answers (wall clock, so downtime counts), never from
 * the replayed body. The step gets the first busy time, so the record it writes says how long it waited
 * (`detail.waitedMs`).
 */
async function untilNotBusy(
  call: (busySince: number | undefined) => Promise<StepOutcome>,
): Promise<StepRecord> {
  let firstBusyAt: number | undefined;
  for (;;) {
    const result = await call(firstBusyAt);
    if (!isBusy(result)) return result;
    firstBusyAt ??= result.at;
    const waited = result.at - firstBusyAt;
    if (waited >= result.deadlineMs) {
      throw new Error(`gave up after waiting ${Math.round(waited / 1000)} s: ${result.busy}`);
    }
    await sleep(result.retryAfterMs);
  }
}

/** Adds the wait policy (from the step's config, not the replayed body) and the time to a busy answer. */
function withPolicy(
  result: StepRecord | Busy,
  { busyRetryMs, busyDeadlineMs }: { busyRetryMs: number; busyDeadlineMs: number },
): StepOutcome {
  if (!isBusy(result)) return result;
  return { ...result, retryAfterMs: busyRetryMs, deadlineMs: busyDeadlineMs, at: Date.now() };
}

async function loadMeetingStep(input: PostMeetingInput): Promise<MeetingRef> {
  'use step';
  const ctx = stepContext();
  try {
    if (!(await isCurrentAttempt(ctx.db, input))) {
      throw new MeetingNotFound(
        `pipeline run ${input.pipelineRunId} attempt ${input.attempt} is gone`,
      );
    }
    return await loadMeeting(ctx, input.meetingId, input.workspaceId);
  } catch (error) {
    throw fatal(error);
  }
}

async function enhanceStep(
  ref: PipelineRunRef,
  m: MeetingRef,
  runId: string,
  busySince: number | undefined,
): Promise<StepOutcome> {
  'use step';
  const ctx = stepContext();
  try {
    return withPolicy(
      await tracked(ref, 'enhance', () => ensureEnhanced(ctx, m, runId), busySince),
      ctx.config,
    );
  } catch (error) {
    throw fatal(error);
  }
}

async function indexStep(ref: PipelineRunRef, m: MeetingRef): Promise<StepRecord> {
  'use step';
  try {
    return await tracked(ref, 'index', () => indexNotes(stepContext(), m));
  } catch (error) {
    throw fatal(error);
  }
}

async function notionStep(
  ref: PipelineRunRef,
  m: MeetingRef,
  busySince: number | undefined,
): Promise<StepOutcome> {
  'use step';
  const ctx = stepContext();
  try {
    return withPolicy(
      await tracked(ref, 'notion', () => pushToNotion(ctx, m), busySince),
      ctx.config,
    );
  } catch (error) {
    throw fatal(error);
  }
}

/** Records the outcome on `pipeline_run` (also after a failure) and returns the run summary. */
async function finishStep(
  ref: PipelineRunRef,
  run: Omit<PostMeetingRun, 'finishedAt'>,
): Promise<PostMeetingRun> {
  'use step';
  const done: PostMeetingRun = { ...run, finishedAt: new Date().toISOString() };
  await finishPipelineRun(
    stepContext().db,
    ref,
    done.status === 'completed'
      ? { status: 'completed' }
      : done.error?.includes(OWNER_NO_ACCESS)
        ? {
            status: 'failed',
            error: 'The note’s owner can no longer edit it, so its post-meeting steps can’t run.',
            code: OWNER_NO_ACCESS,
          }
        : { status: 'failed', error: userFacingError(done.error) },
  );
  return done;
}

/** What the meeting header shows for a failed run (the raw message stays in the workflow record / logs). */
function userFacingError(message: string | undefined): string {
  if (!message) return 'The post-meeting steps failed.';
  if (message.startsWith('gave up after waiting')) {
    return message.includes('notion')
      ? 'Sending to Notion stayed blocked by another send. Try again.'
      : 'Another enhancement of this note kept running. Try again.';
  }
  // A step whose retries ran out names itself ("Step \"…//enhanceStep\" exceeded max retries").
  if (/enhanceStep|enhance failed/.test(message)) return 'Enhancing the notes failed. Try again.';
  if (/indexStep/.test(message)) return 'Indexing the notes failed. Try again.';
  if (/notionStep/.test(message)) return 'Sending the notes to Notion failed. Try again.';
  if (/not found in workspace|is gone/.test(message)) {
    return 'This meeting is no longer available to the pipeline.';
  }
  return 'The post-meeting steps failed. Try again.';
}
