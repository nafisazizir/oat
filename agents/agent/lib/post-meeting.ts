/**
 * The post-meeting pipeline as a durable eve workflow (8.2 spike; production wiring is 8.3):
 *
 *   load meeting (in the caller's workspace) → (1) enhance unless done → (2) index the notes →
 *   [durable wait] → (3) Notion auto-push → (4) record the run
 *
 * The body is replayed after every wait, crash or redeploy, so it only orchestrates; each `"use step"`
 * function runs once, and its result is recorded by the Workflow world and replayed afterwards. Steps are
 * thin wrappers over the plain functions in `src/post-meeting/steps.ts`:
 *
 * - "busy" (another run of the note is live, a push holds the lease) is a *result*, not an error: the body
 *   sleeps (durable, holds no compute) and calls the step again until `busyDeadlineMs` — beyond D-26's
 *   staleness, so even our own run orphaned by a crash mid-generation is settled and replaced — then fails
 *   with a clear message. Errors would spend the step's retry budget (3 retries) within seconds.
 * - A missing meeting, or one outside the caller's workspace → `FatalError` (no retries).
 * - Anything else → the step's normal retries with backoff.
 */
import { FatalError, getWorkflowMetadata, sleep } from 'eve/workflow';

import { stepContext } from '../../src/post-meeting/context.ts';
import { recordRun } from '../../src/post-meeting/run-log.ts';
import {
  ensureEnhanced,
  indexNotes,
  loadMeeting,
  pushToNotion,
} from '../../src/post-meeting/steps.ts';
import {
  type Busy,
  isBusy,
  MeetingNotFound,
  type MeetingRef,
  type PostMeetingInput,
  type PostMeetingRun,
  type StepOutcome,
  type StepRecord,
} from '../../src/post-meeting/types.ts';

export async function postMeetingWorkflow(input: PostMeetingInput): Promise<PostMeetingRun> {
  'use workflow';
  const meta = getWorkflowMetadata();
  const steps: StepRecord[] = [];
  let meetingRef: MeetingRef | undefined;
  const run = (
    status: PostMeetingRun['status'],
    error?: string,
  ): Omit<PostMeetingRun, 'finishedAt'> => ({
    runId: meta.workflowRunId,
    meetingId: input.meetingId,
    documentId: meetingRef?.documentId ?? null,
    status,
    startedAt: new Date(meta.workflowStartedAt).toISOString(),
    steps,
    ...(error ? { error } : {}),
  });
  try {
    const m = await loadMeetingStep(input.meetingId, input.workspaceId);
    meetingRef = m;
    steps.push(await untilNotBusy(() => enhanceStep(m, meta.workflowRunId)));
    steps.push(await indexStep(m));
    if (input.pushDelayMs && input.pushDelayMs > 0) await sleep(input.pushDelayMs);
    steps.push(await untilNotBusy(() => notionStep(m)));
  } catch (error) {
    await recordRunStep(run('failed', error instanceof Error ? error.message : String(error)));
    throw error;
  }
  return recordRunStep(run('completed'));
}

/**
 * Calls a step until it isn't busy, sleeping durably in between; fails once the deadline has passed since the
 * first busy answer. Times come from the steps' recorded answers (wall clock, so downtime counts), never from
 * the replayed body. A step that waited reports it as `detail.waitedMs`.
 */
async function untilNotBusy(call: () => Promise<StepOutcome>): Promise<StepRecord> {
  let firstBusyAt: number | undefined;
  for (;;) {
    const result = await call();
    if (!isBusy(result)) {
      if (firstBusyAt === undefined) return result;
      const waitedMs = Math.max(0, Date.parse(result.at) - firstBusyAt);
      return { ...result, detail: { ...result.detail, waitedMs } };
    }
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

async function loadMeetingStep(meetingId: string, workspaceId: string): Promise<MeetingRef> {
  'use step';
  try {
    return await loadMeeting(stepContext(), meetingId, workspaceId);
  } catch (error) {
    if (error instanceof MeetingNotFound) throw new FatalError(error.message);
    throw error;
  }
}

async function enhanceStep(m: MeetingRef, runId: string): Promise<StepOutcome> {
  'use step';
  const ctx = stepContext();
  return withPolicy(await ensureEnhanced(ctx, m, runId), ctx.config);
}

async function indexStep(m: MeetingRef): Promise<StepRecord> {
  'use step';
  return indexNotes(stepContext(), m);
}

async function notionStep(m: MeetingRef): Promise<StepOutcome> {
  'use step';
  const ctx = stepContext();
  return withPolicy(await pushToNotion(ctx, m), ctx.config);
}

async function recordRunStep(run: Omit<PostMeetingRun, 'finishedAt'>): Promise<PostMeetingRun> {
  'use step';
  const done: PostMeetingRun = { ...run, finishedAt: new Date().toISOString() };
  await recordRun(stepContext(), done);
  return done;
}
