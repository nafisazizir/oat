/**
 * The post-meeting pipeline's run log and hand-over to the background agents (8.3, D-29).
 *
 * The web app owns the *request*: when a meeting ends (desktop sync push, or the meeting header's
 * "Run"/"Retry"), it authorises the user against the note (`@oat/core`: owner/editor), creates the meeting's one
 * `pipeline_run` row and hands the job to the agents server (`POST /jobs/post-meeting` with the service token).
 * The agents own the *work*: a durable eve workflow (enhance → index → Notion) that records each step here.
 *
 * - Idempotent per meeting *end*: `pipeline_run.meeting_id` is unique; asking again for the same end returns the
 *   existing run. A later end (the meeting was resumed and ended again, D-24) runs it again as the next
 *   `attempt` (at once if finished, after the live attempt otherwise). A retry (retryable failed runs only)
 *   bumps `attempt` too; the agents' writes are fenced on `attempt`.
 * - Runs that look live but went quiet are settled from the Workflow world's record ({@link recoverStuckRuns}).
 * - The agents server down (or not configured) is not an error: the run stays `waiting` ("waiting for the
 *   pipeline") and a backstop sweep hands it over later, with backoff ({@link sweepPipelineRuns}: the agents'
 *   minute schedule, plus the status read of a waiting run). A hand-over is claimed for {@link DISPATCH_LEASE_MS}
 *   first, so two sweepers never send the same job twice; the agents dedupe repeats of one attempt anyway
 *   ({@link startPipelineWorkflow}).
 */
import { randomUUID } from 'node:crypto';

import { canEditDocument, canReadDocument, roleIn } from '@oat/core';
import {
  type Db,
  document,
  type DocumentRow,
  integration,
  meeting,
  type MeetingRow,
  pipelineRun,
  type PipelineRunRow,
  pipelineSetting,
  transcriptSegment,
} from '@oat/db';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type { Actor } from './actor.ts';
import type {
  PipelineRunDto,
  PipelineRunResponse,
  PipelineSettingsDto,
  PipelineStepName,
  PipelineStepRecord,
  UpdatePipelineSettingsInput,
} from './dto/pipeline.ts';
import { ApiError, forbidden, notFound } from './errors.ts';

/** A hand-over in flight holds the run this long (another sweeper skips it meanwhile). */
export const DISPATCH_LEASE_MS = 30_000;
/** Retry delay after the n-th failed hand-over: 5 s, 10 s, 20 s … capped at 5 min. */
export const dispatchBackoffMs = (attempts: number) =>
  Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);

/** What the web app sends the agents (D-29 `/jobs` contract: the workspace it checked rides along). */
export interface PostMeetingJob {
  pipelineRunId: string;
  attempt: number;
  meetingId: string;
  workspaceId: string;
}

/** Hands a job to the agents; resolves with the Workflow run id, throws {@link DispatchError} otherwise. */
export interface PipelineDispatcher {
  dispatch(job: PostMeetingJob): Promise<{ workflowRunId: string }>;
}

/**
 * A failed hand-over. `permanent`: the agents refused the job itself (unknown meeting, superseded attempt), so
 * the run fails instead of waiting; anything else (unreachable, 5xx, misconfigured token) is retried.
 */
export class DispatchError extends Error {
  override readonly name = 'DispatchError';
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

export interface PipelineDeps {
  db: Db;
  /** `null`: no agents server configured (runs wait; the agents' own sweep picks them up). */
  dispatcher: PipelineDispatcher | null;
  logError?: (message: string, error: unknown) => void;
}

// --- the agents' HTTP client -------------------------------------------------------------------------------

/** The agents server (`agents/`, eve) as a {@link PipelineDispatcher}: `POST <url>/jobs/post-meeting`. */
export function createAgentsDispatcher(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): PipelineDispatcher {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, '')}/jobs/post-meeting`;
  return {
    async dispatch(job) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(job),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (error) {
        throw new DispatchError(
          `agents unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const body = (await res.json().catch(() => null)) as {
        runId?: string;
        error?: string;
      } | null;
      if (res.status === 202 && body?.runId) return { workflowRunId: body.runId };
      // 400/404/409: this job can never run (bad ids, the note left the workspace, a newer attempt exists).
      const permanent = res.status === 400 || res.status === 404 || res.status === 409;
      throw new DispatchError(
        `agents answered ${res.status} ${body?.error ?? ''}`.trim(),
        permanent,
      );
    },
  };
}

/** Default port of the agents server (`agents/src/cli/serve.ts`); eve's own defaults clash with the web app. */
export const DEFAULT_AGENTS_URL = 'http://127.0.0.1:3100';

/** `OAT_AGENTS_URL` + `OAT_AGENTS_TOKEN`; `null` without a usable token (≥ 32 characters). */
export function agentsDispatcherFromEnv(
  env: Record<string, string | undefined> = process.env,
): PipelineDispatcher | null {
  const token = env.OAT_AGENTS_TOKEN?.trim();
  if (!token || token.length < 32) return null;
  return createAgentsDispatcher({ url: env.OAT_AGENTS_URL?.trim() || DEFAULT_AGENTS_URL, token });
}

// --- reads ---------------------------------------------------------------------------------------------------

export { OWNER_NO_ACCESS } from './dto/pipeline.ts';

export function toPipelineRunDto(row: PipelineRunRow): PipelineRunDto {
  const failed = row.status === 'failed';
  return {
    id: row.id,
    meetingId: row.meetingId,
    documentId: row.documentId,
    status: row.status,
    attempt: row.attempt,
    currentStep: (row.currentStep as PipelineStepName | null) ?? null,
    steps: row.steps as PipelineStepRecord[],
    error: failed ? row.error : null,
    retryable: failed && row.errorCode === null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function runById(db: Db, id: string): Promise<PipelineRunRow | undefined> {
  const [row] = await db.select().from(pipelineRun).where(eq(pipelineRun.id, id));
  return row;
}

async function runOfMeeting(db: Db, meetingId: string): Promise<PipelineRunRow | undefined> {
  const [row] = await db.select().from(pipelineRun).where(eq(pipelineRun.meetingId, meetingId));
  return row;
}

/** The meeting note + its meeting row; 404 when the actor can't read it (no existence leak). */
async function readableMeetingNote(
  db: Db,
  actor: Actor,
  where: { documentId: string } | { meetingId: string },
): Promise<{ doc: DocumentRow; meet: MeetingRow | undefined }> {
  const [row] = await db
    .select({ doc: document, meet: meeting })
    .from(document)
    .leftJoin(meeting, eq(meeting.documentId, document.id))
    .where(
      'documentId' in where ? eq(document.id, where.documentId) : eq(meeting.id, where.meetingId),
    );
  if (!row || !canReadDocument(actor.ctx, row.doc)) throw notFound();
  return { doc: row.doc, meet: row.meet ?? undefined };
}

/** Owner/editor of a live meeting note whose meeting has ended (D-29: the web app authorises first). */
function assertCanRun(actor: Actor, doc: DocumentRow, meet: MeetingRow | undefined): MeetingRow {
  if (!canEditDocument(actor.ctx, doc)) {
    throw forbidden('Only people who can edit this note can run its post-meeting steps.');
  }
  if (doc.kind !== 'meeting' || !meet) throw notFound('Meeting');
  if (!meet.endedAt) {
    throw new ApiError(409, 'meeting_not_ended', 'The meeting hasn’t ended yet.');
  }
  return meet;
}

function response(
  actor: Actor,
  doc: DocumentRow,
  meet: MeetingRow | undefined,
  row: PipelineRunRow | undefined,
): PipelineRunResponse {
  const meetingEnded = doc.kind === 'meeting' && !!meet?.endedAt;
  return {
    run: row ? toPipelineRunDto(row) : null,
    meetingEnded,
    canRun: meetingEnded && canEditDocument(actor.ctx, doc),
  };
}

/**
 * The note's run, for the meeting header (read access), with whether its meeting ended and whether the caller
 * may start/retry it. A `waiting` run that is due is handed over right here, so a run recovers as soon as
 * someone looks at it after the agents came back.
 */
export async function getPostMeetingRun(
  deps: PipelineDeps,
  actor: Actor,
  documentId: string,
): Promise<PipelineRunResponse> {
  const { doc, meet } = await readableMeetingNote(deps.db, actor, { documentId });
  let row = meet ? await runOfMeeting(deps.db, meet.id) : undefined;
  if (row?.status === 'waiting') {
    await dispatchPipelineRun(deps, row.id);
    row = (await runById(deps.db, row.id)) ?? row;
  }
  return response(actor, doc, meet, row);
}

// --- requests ------------------------------------------------------------------------------------------------

/** The fields that make a row the next, fresh attempt (`waiting`, nothing done yet). */
const nextAttempt = (extra: Partial<typeof pipelineRun.$inferInsert> = {}) => ({
  status: 'waiting' as const,
  attempt: sql`${pipelineRun.attempt} + 1`,
  currentStep: null,
  steps: [],
  error: null,
  errorCode: null,
  workflowRunId: null,
  dispatchAttempts: 0,
  dispatchError: null,
  nextDispatchAt: null,
  startedAt: null,
  finishedAt: null,
  rerunRequested: false,
  ...extra,
});

/**
 * Starts the post-meeting pipeline for a meeting that ended, as `actor` (owner/editor of the note), or returns
 * the run it already has. Hands it to the agents right away; if they can't take it, it waits for the sweep. A
 * meeting that ended *again* (resumed, D-24) runs again: see {@link startOrReturn}.
 */
export async function requestPostMeeting(
  deps: PipelineDeps,
  actor: Actor,
  meetingId: string,
): Promise<PipelineRunDto> {
  const { doc, meet } = await readableMeetingNote(deps.db, actor, { meetingId });
  return (await startOrReturn(deps, actor, doc, assertCanRun(actor, doc, meet))).run!;
}

/**
 * The meeting's run, created if missing. If the meeting ended later than the end the run was asked for (it was
 * resumed and ended again): a finished run becomes the next attempt now; a live one is flagged and becomes the
 * next attempt when it finishes ({@link finishPipelineRun}); a waiting one just covers the new end.
 */
async function startOrReturn(
  deps: PipelineDeps,
  actor: Actor,
  doc: DocumentRow,
  meet: MeetingRow,
): Promise<PipelineRunResponse> {
  const endedAt = meet.endedAt!;
  const [created] = await deps.db
    .insert(pipelineRun)
    .values({
      meetingId: meet.id,
      documentId: doc.id,
      workspaceId: doc.workspaceId,
      requestedBy: actor.userId,
      endedAt,
    })
    .onConflictDoNothing({ target: pipelineRun.meetingId })
    .returning();
  if (created) {
    await dispatchPipelineRun(deps, created.id);
    return response(actor, doc, meet, await runById(deps.db, created.id));
  }
  // A few rounds at most: the row can change state between our read and our write.
  for (let round = 0; round < 3; round++) {
    const row = (await runOfMeeting(deps.db, meet.id))!;
    if (row.endedAt && row.endedAt.getTime() >= endedAt.getTime()) {
      return response(actor, doc, meet, row);
    }
    const same = and(
      eq(pipelineRun.id, row.id),
      eq(pipelineRun.attempt, row.attempt),
      eq(pipelineRun.status, row.status),
    );
    let changed: PipelineRunRow | undefined;
    if (row.status === 'completed' || row.status === 'failed') {
      [changed] = await deps.db
        .update(pipelineRun)
        .set(nextAttempt({ endedAt, workspaceId: doc.workspaceId, requestedBy: actor.userId }))
        .where(same)
        .returning();
      if (changed) await dispatchPipelineRun(deps, changed.id);
    } else if (row.status === 'waiting') {
      [changed] = await deps.db.update(pipelineRun).set({ endedAt }).where(same).returning();
    } else {
      [changed] = await deps.db
        .update(pipelineRun)
        .set({ endedAt, rerunRequested: true })
        .where(same)
        .returning();
    }
    if (changed) return response(actor, doc, meet, await runById(deps.db, row.id));
  }
  return response(actor, doc, meet, await runOfMeeting(deps.db, meet.id));
}

/**
 * "Run" / "Retry" from the meeting header (owner/editor): no run yet (or the meeting ended again) → start one; a
 * retryable failed run → the next attempt (fresh steps, same row); a waiting run → hand it over if it is due
 * (never past a hand-over in flight or its backoff); otherwise unchanged.
 */
export async function retryPostMeeting(
  deps: PipelineDeps,
  actor: Actor,
  documentId: string,
): Promise<PipelineRunResponse> {
  const { doc, meet } = await readableMeetingNote(deps.db, actor, { documentId });
  const m = assertCanRun(actor, doc, meet);
  const row = await runOfMeeting(deps.db, m.id);
  const newerEnd = row && (!row.endedAt || row.endedAt.getTime() < m.endedAt!.getTime());
  if (row && !newerEnd && row.status === 'failed' && row.errorCode === null) {
    const [next] = await deps.db
      .update(pipelineRun)
      .set(
        // The workspace the user is authorised against *now* (the note may have moved).
        nextAttempt({ workspaceId: doc.workspaceId, requestedBy: actor.userId }),
      )
      .where(
        and(
          eq(pipelineRun.id, row.id),
          eq(pipelineRun.status, 'failed'),
          eq(pipelineRun.attempt, row.attempt),
        ),
      )
      .returning();
    // Lost a race with another retry: theirs stands.
    if (next) await dispatchPipelineRun(deps, next.id);
    return response(actor, doc, m, await runById(deps.db, row.id));
  }
  if (row && !newerEnd && row.status === 'waiting') {
    await dispatchPipelineRun(deps, row.id);
    return response(actor, doc, m, await runById(deps.db, row.id));
  }
  return startOrReturn(deps, actor, doc, m);
}

// --- hand-over + sweep ----------------------------------------------------------------------------------------

const due = () =>
  and(
    eq(pipelineRun.status, 'waiting'),
    or(isNull(pipelineRun.nextDispatchAt), lte(pipelineRun.nextDispatchAt, sql`now()`)),
  );

/** What one hand-over did: `skipped` = not waiting, not due, or another sweeper holds it. */
export type DispatchOutcome = 'handed_over' | 'waiting' | 'refused' | 'skipped';

/**
 * Hands one waiting, due run to the agents (no-op otherwise): claims it for {@link DISPATCH_LEASE_MS}, sends
 * the job, then records `queued` (the agents do too) or the failure and the next try. Never throws.
 */
export async function dispatchPipelineRun(
  deps: PipelineDeps,
  runId: string,
): Promise<DispatchOutcome> {
  const [claimed] = await deps.db
    .update(pipelineRun)
    .set({
      dispatchAttempts: sql`${pipelineRun.dispatchAttempts} + 1`,
      nextDispatchAt: sql`now() + make_interval(secs => ${DISPATCH_LEASE_MS / 1000})`,
    })
    .where(and(eq(pipelineRun.id, runId), due()))
    .returning();
  if (!claimed) return 'skipped';
  const fence = and(
    eq(pipelineRun.id, claimed.id),
    eq(pipelineRun.attempt, claimed.attempt),
    eq(pipelineRun.status, 'waiting'),
  );
  const retryLater = (message: string, delayMs = dispatchBackoffMs(claimed.dispatchAttempts)) =>
    deps.db
      .update(pipelineRun)
      .set({
        dispatchError: message.slice(0, 500),
        nextDispatchAt: sql`now() + make_interval(secs => ${delayMs / 1000})`,
      })
      .where(fence);
  if (!deps.dispatcher) {
    // Nothing to retry from here: the agents' own sweep (or a configured web app) hands it over.
    await retryLater('the agents server is not configured (OAT_AGENTS_TOKEN)', 5 * 60_000);
    return 'waiting';
  }
  try {
    const { workflowRunId } = await deps.dispatcher.dispatch({
      pipelineRunId: claimed.id,
      attempt: claimed.attempt,
      meetingId: claimed.meetingId,
      workspaceId: claimed.workspaceId,
    });
    await deps.db
      .update(pipelineRun)
      .set({ status: 'queued', workflowRunId, dispatchError: null, nextDispatchAt: null })
      .where(fence);
    return 'handed_over';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DispatchError && error.permanent) {
      await deps.db
        .update(pipelineRun)
        .set({
          status: 'failed',
          error: 'The post-meeting steps couldn’t start for this note.',
          dispatchError: message.slice(0, 500),
          nextDispatchAt: null,
          finishedAt: new Date(),
        })
        .where(fence);
      (deps.logError ?? console.error)(`pipeline: run ${claimed.id} refused by the agents`, error);
      return 'refused';
    }
    await retryLater(message).catch((e: unknown) =>
      (deps.logError ?? console.error)('pipeline: could not record a failed hand-over', e),
    );
    return 'waiting';
  }
}

/**
 * The backstop: hands over every waiting run that is due (oldest first, up to `limit`). Called by the agents'
 * minute schedule; safe to run anywhere, any number of times at once.
 */
export async function sweepPipelineRuns(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<{ dispatched: number; waiting: number }> {
  const rows = await deps.db
    .select({ id: pipelineRun.id })
    .from(pipelineRun)
    .where(due())
    .orderBy(asc(pipelineRun.createdAt))
    .limit(options.limit ?? 20);
  const totals = { dispatched: 0, waiting: 0 };
  for (const { id } of rows) {
    const outcome = await dispatchPipelineRun(deps, id);
    if (outcome === 'handed_over') totals.dispatched += 1;
    else if (outcome === 'waiting') totals.waiting += 1;
  }
  return totals;
}

/** A Workflow run's state as the world reports it; `missing` = the world doesn't know it (lost). */
export type WorkflowRunState =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missing';

/** `queued`/`running` rows untouched for this long are checked against the world (busy waits touch every 5 s). */
export const STUCK_AFTER_MS = 10 * 60_000;

/** User-facing message of a run whose workflow stopped without recording an outcome. */
export const STOPPED_MESSAGE = 'The post-meeting steps stopped. Try again.';

/**
 * The other backstop (the agents' minute schedule): runs that look live but haven't moved for
 * {@link STUCK_AFTER_MS}. Their Workflow run decides: gone / failed / cancelled → `failed` (retryable);
 * completed → `completed` (its finish step was lost); still running (e.g. a durable wait) → left alone. A
 * `queued` row whose workflow never started goes back to `waiting` for the hand-over sweep.
 */
export async function recoverStuckRuns(
  db: Db,
  workflowState: (workflowRunId: string) => Promise<WorkflowRunState>,
  options: { olderThanMs?: number; limit?: number } = {},
): Promise<{ failed: number; completed: number; requeued: number; alive: number }> {
  const totals = { failed: 0, completed: 0, requeued: 0, alive: 0 };
  const rows = await db
    .select()
    .from(pipelineRun)
    .where(
      and(
        inArray(pipelineRun.status, ['queued', 'running']),
        lte(
          pipelineRun.updatedAt,
          sql`now() - make_interval(secs => ${(options.olderThanMs ?? STUCK_AFTER_MS) / 1000})`,
        ),
      ),
    )
    .orderBy(asc(pipelineRun.updatedAt))
    .limit(options.limit ?? 20);
  for (const row of rows) {
    const ref = { pipelineRunId: row.id, attempt: row.attempt };
    if (!row.workflowRunId || row.workflowRunId.startsWith(STARTING)) {
      const [back] = await db
        .update(pipelineRun)
        .set({ status: 'waiting', workflowRunId: null, nextDispatchAt: null })
        .where(and(fenced(ref), eq(pipelineRun.status, row.status)))
        .returning();
      if (back) totals.requeued += 1;
      continue;
    }
    let state: WorkflowRunState;
    try {
      state = await workflowState(row.workflowRunId);
    } catch {
      continue; // the world is unreachable: try again next time
    }
    if (state === 'completed') {
      await finishPipelineRun(db, ref, { status: 'completed' });
      totals.completed += 1;
    } else if (state === 'failed' || state === 'cancelled' || state === 'missing') {
      await finishPipelineRun(db, ref, { status: 'failed', error: STOPPED_MESSAGE });
      totals.failed += 1;
    } else {
      // Still going: touch it, so it is looked at again only after another quiet period.
      await db
        .update(pipelineRun)
        .set({ updatedAt: new Date() })
        .where(and(fenced(ref), eq(pipelineRun.status, row.status)));
      totals.alive += 1;
    }
  }
  return totals;
}

// --- the agents' side: start + step records (fenced on the attempt) ----------------------------------------

export type PipelineRunRef = { pipelineRunId: string; attempt: number };

const fenced = (ref: PipelineRunRef) =>
  and(eq(pipelineRun.id, ref.pipelineRunId), eq(pipelineRun.attempt, ref.attempt));

/**
 * `workflow_run_id` while a start is in flight: `starting:<ms>:<random>`. Repeats wait for the real id; one older
 * than {@link STARTING_STALE_MS} (its process died between claiming and starting) may be taken over.
 */
const STARTING = 'starting:';
const STARTING_STALE_MS = 60_000;
const startingAge = (id: string) => Date.now() - Number(id.split(':')[1] ?? 0);

export type StartPipelineResult =
  | { status: 'started' | 'existing'; workflowRunId: string }
  | { status: 'not_found' | 'superseded' };

/**
 * The agents' `/jobs/post-meeting`: starts the workflow for this attempt once. The attempt is claimed under a row
 * lock (a placeholder run id), then `start` runs *after* that commit, so a failed commit can never leave a
 * workflow running that the row doesn't know about; concurrent repeats wait for the real id (up to
 * `waitMs`). A start that throws releases the claim.
 */
export async function startPipelineWorkflow(
  db: Db,
  job: PostMeetingJob,
  start: () => Promise<string>,
  options: { waitMs?: number } = {},
): Promise<StartPipelineResult> {
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  for (;;) {
    const claim = await db.transaction(
      async (
        tx,
      ): Promise<
        StartPipelineResult | { status: 'claimed'; token: string } | { status: 'pending' }
      > => {
        const [row] = await tx
          .select()
          .from(pipelineRun)
          .where(eq(pipelineRun.id, job.pipelineRunId))
          .for('update');
        if (!row || row.meetingId !== job.meetingId || row.workspaceId !== job.workspaceId) {
          return { status: 'not_found' };
        }
        if (row.attempt !== job.attempt) return { status: 'superseded' };
        const current = row.workflowRunId;
        if (current && !current.startsWith(STARTING)) {
          return { status: 'existing', workflowRunId: current };
        }
        if (row.status !== 'waiting' && row.status !== 'queued') return { status: 'superseded' };
        if (current && startingAge(current) < STARTING_STALE_MS) return { status: 'pending' };
        const token = `${STARTING}${Date.now()}:${randomUUID()}`;
        await tx
          .update(pipelineRun)
          .set({ workflowRunId: token })
          .where(eq(pipelineRun.id, row.id));
        return { status: 'claimed', token };
      },
    );
    if (claim.status === 'pending') {
      if (Date.now() > deadline) throw new Error('a start of this attempt is still in progress');
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    if (claim.status !== 'claimed') return claim;
    const mine = and(
      eq(pipelineRun.id, job.pipelineRunId),
      eq(pipelineRun.workflowRunId, claim.token),
    );
    let workflowRunId: string;
    try {
      workflowRunId = await start();
    } catch (error) {
      await db.update(pipelineRun).set({ workflowRunId: null }).where(mine);
      throw error;
    }
    await db
      .update(pipelineRun)
      .set({ status: 'queued', workflowRunId, dispatchError: null, nextDispatchAt: null })
      .where(and(mine, inArray(pipelineRun.status, ['waiting', 'queued'])));
    return { status: 'started', workflowRunId };
  }
}

/** Whether this attempt is still the run's current one (a superseded workflow stops writing). */
export async function isCurrentAttempt(db: Db, ref: PipelineRunRef): Promise<boolean> {
  const [row] = await db.select({ id: pipelineRun.id }).from(pipelineRun).where(fenced(ref));
  return row !== undefined;
}

/** A step starts: `running`, on `step`. */
export async function markPipelineStep(
  db: Db,
  ref: PipelineRunRef,
  step: PipelineStepName,
): Promise<void> {
  await db
    .update(pipelineRun)
    .set({
      status: 'running',
      currentStep: step,
      startedAt: sql`coalesce(${pipelineRun.startedAt}, now())`,
    })
    .where(and(fenced(ref), inArray(pipelineRun.status, ['queued', 'running'])));
}

/** A step finished: its record replaces any earlier one of the same step (a re-run step writes once). */
export async function recordPipelineStep(
  db: Db,
  ref: PipelineRunRef,
  record: PipelineStepRecord,
): Promise<void> {
  const others = sql`coalesce((
    select jsonb_agg(e order by n) from jsonb_array_elements(${pipelineRun.steps}) with ordinality as t(e, n)
    where e->>'step' <> ${record.step}
  ), '[]'::jsonb)`;
  await db
    .update(pipelineRun)
    .set({
      steps: sql`${others} || jsonb_build_array(${JSON.stringify(record)}::jsonb)`,
      currentStep: null,
    })
    .where(and(fenced(ref), inArray(pipelineRun.status, ['queued', 'running'])));
}

/**
 * The attempt is over. If the meeting ended again meanwhile (`rerun_requested`), the row becomes the next attempt
 * (`waiting`; the hand-over sweep picks it up) instead — unless no attempt could ever succeed
 * (`code`: {@link OWNER_NO_ACCESS}). `stale`: this attempt was no longer the live one (nothing written).
 */
export async function finishPipelineRun(
  db: Db,
  ref: PipelineRunRef,
  outcome: { status: 'completed' } | { status: 'failed'; error: string; code?: string },
): Promise<'finished' | 'rerun' | 'stale'> {
  return db.transaction(async (tx) => {
    const live = and(fenced(ref), inArray(pipelineRun.status, ['queued', 'running']));
    const [row] = await tx.select().from(pipelineRun).where(live).for('update');
    if (!row) return 'stale';
    const fatal = outcome.status === 'failed' && outcome.code !== undefined;
    if (row.rerunRequested && !fatal) {
      await tx.update(pipelineRun).set(nextAttempt()).where(eq(pipelineRun.id, row.id));
      return 'rerun';
    }
    await tx
      .update(pipelineRun)
      .set({
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error.slice(0, 1000) : null,
        errorCode: outcome.status === 'failed' ? (outcome.code ?? null) : null,
        currentStep: null,
        rerunRequested: false,
        finishedAt: new Date(),
      })
      .where(eq(pipelineRun.id, row.id));
    return 'finished';
  });
}

// --- auto-enhance: minimum transcript (7.5) --------------------------------------------------------------------

/**
 * Auto-enhance needs this much speech in the transcript (7.5): an accidental few seconds of recording is left as
 * written (the Enhance button still works). The agents' enhance step checks it (`OAT_AUTO_ENHANCE_MIN_SPEECH_MS`
 * overrides it in tests).
 */
export const MIN_AUTO_ENHANCE_SPEECH_MS = 60_000;

/** Time covered by transcript segments (ms), overlaps counted once (both sources talking = one stretch). */
export function speechMs(segments: readonly { startMs: number; endMs: number }[]): number {
  const sorted = segments
    .filter((s) => s.endMs > s.startMs)
    .map((s) => [s.startMs, s.endMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let from = -Infinity;
  let to = -Infinity;
  for (const [start, end] of sorted) {
    if (start > to) {
      if (to > from) total += to - from;
      from = start;
      to = end;
    } else if (end > to) to = end;
  }
  if (to > from) total += to - from;
  return total;
}

/** {@link speechMs} of a meeting's stored transcript (finals, like every other read). */
export async function meetingSpeechMs(db: Db, meetingId: string): Promise<number> {
  const rows = await db
    .select({ startMs: transcriptSegment.startMs, endMs: transcriptSegment.endMs })
    .from(transcriptSegment)
    .where(and(eq(transcriptSegment.meetingId, meetingId), eq(transcriptSegment.isFinal, true)));
  return speechMs(rows);
}

// --- settings --------------------------------------------------------------------------------------------------

/** The note owner's switches for the note's workspace (defaults without a row). */
export async function pipelineSwitches(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<{ autoEnhance: boolean }> {
  const [row] = await db
    .select({ autoEnhance: pipelineSetting.autoEnhance })
    .from(pipelineSetting)
    .where(and(eq(pipelineSetting.userId, userId), eq(pipelineSetting.workspaceId, workspaceId)));
  return { autoEnhance: row?.autoEnhance ?? true };
}

async function notionConnection(db: Db, userId: string, workspaceId: string) {
  const [row] = await db
    .select({ id: integration.id, settingsJson: integration.settingsJson })
    .from(integration)
    .where(
      and(
        eq(integration.userId, userId),
        eq(integration.workspaceId, workspaceId),
        eq(integration.provider, 'notion'),
      ),
    );
  return row;
}

function requireMember(actor: Actor, workspaceId: string) {
  // Same answer for "no such workspace" and "not a member": no existence leak.
  if (!roleIn(actor.ctx, workspaceId)) throw notFound('Workspace');
}

/** The actor's own post-meeting settings for a workspace they belong to. */
export async function getPipelineSettings(
  db: Db,
  actor: Actor,
  workspaceId: string,
): Promise<PipelineSettingsDto> {
  requireMember(actor, workspaceId);
  const [{ autoEnhance }, notion] = await Promise.all([
    pipelineSwitches(db, actor.userId, workspaceId),
    notionConnection(db, actor.userId, workspaceId),
  ]);
  return {
    workspaceId,
    autoEnhance,
    autoSendToNotion: notion ? notion.settingsJson.autoPush === true : null,
  };
}

/** Changes the actor's own settings (never anyone else's: always `actor.userId`). */
export async function updatePipelineSettings(
  db: Db,
  actor: Actor,
  input: UpdatePipelineSettingsInput,
): Promise<PipelineSettingsDto> {
  requireMember(actor, input.workspaceId);
  if (input.autoEnhance !== undefined) {
    await db
      .insert(pipelineSetting)
      .values({
        workspaceId: input.workspaceId,
        userId: actor.userId,
        autoEnhance: input.autoEnhance,
      })
      .onConflictDoUpdate({
        target: [pipelineSetting.workspaceId, pipelineSetting.userId],
        set: { autoEnhance: input.autoEnhance, updatedAt: new Date() },
      });
  }
  if (input.autoSendToNotion !== undefined) {
    const notion = await notionConnection(db, actor.userId, input.workspaceId);
    if (!notion) {
      throw new ApiError(
        409,
        'notion_not_connected',
        'Connect Notion in Settings → Integrations first.',
      );
    }
    // One key, merged in SQL: concurrent target/reconnect writes keep their fields.
    await db
      .update(integration)
      .set({
        settingsJson: sql`${integration.settingsJson} || jsonb_build_object('autoPush', ${input.autoSendToNotion}::boolean)`,
      })
      .where(eq(integration.id, notion.id));
  }
  return getPipelineSettings(db, actor, input.workspaceId);
}
