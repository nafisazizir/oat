/**
 * The agents' side of `pipeline_run` (8.3) against a throwaway database: starting the workflow once per attempt
 * (concurrent repeats, stale attempts, unknown runs) and the step records (idempotent per step, fenced on the
 * attempt). The web side (request, authz, hand-over, sweep, retry) is `apps/web/src/server/pipeline`.
 */
import {
  createDb,
  type Db,
  document,
  meeting,
  membership,
  migrate,
  newId,
  pipelineRun,
  user,
  workspace,
} from '@oat/db';
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  finishPipelineRun,
  isCurrentAttempt,
  markPipelineStep,
  OWNER_NO_ACCESS,
  type PostMeetingJob,
  recordPipelineStep,
  recoverStuckRuns,
  startPipelineWorkflow,
  STOPPED_MESSAGE,
  toPipelineRunDto,
  type WorkflowRunState,
} from './pipeline.ts';

let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 6 });
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

async function seedRun(): Promise<PostMeetingJob> {
  const ownerId = newId();
  await db.insert(user).values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Ada' });
  const workspaceId = newId();
  await db
    .insert(workspace)
    .values({ id: workspaceId, name: 'W', slug: `w-${workspaceId}`, createdBy: ownerId });
  await db.insert(membership).values({ workspaceId, userId: ownerId, role: 'owner' });
  const documentId = newId();
  await db.insert(document).values({
    id: documentId,
    workspaceId,
    ownerId,
    kind: 'meeting',
    title: 'Sync',
    visibility: 'private',
    contentJson: { type: 'doc', content: [] },
  });
  const meetingId = newId();
  await db.insert(meeting).values({ id: meetingId, documentId, endedAt: new Date() });
  const [run] = await db
    .insert(pipelineRun)
    .values({ meetingId, documentId, workspaceId, requestedBy: ownerId })
    .returning();
  return { pipelineRunId: run!.id, attempt: 1, meetingId, workspaceId };
}

const rowOf = async (id: string) =>
  (await db.select().from(pipelineRun).where(eq(pipelineRun.id, id)))[0]!;

describe('startPipelineWorkflow', () => {
  it('starts once per attempt, also for concurrent repeats', async () => {
    const job = await seedRun();
    let starts = 0;
    const start = async () => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 50));
      return `wrun_${starts}`;
    };
    const results = await Promise.all([
      startPipelineWorkflow(db, job, start),
      startPipelineWorkflow(db, job, start),
      startPipelineWorkflow(db, job, start),
    ]);
    expect(starts).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(['existing', 'existing', 'started']);
    expect(new Set(results.map((r) => ('workflowRunId' in r ? r.workflowRunId : null)))).toEqual(
      new Set(['wrun_1']),
    );
    expect(await rowOf(job.pipelineRunId)).toMatchObject({
      status: 'queued',
      workflowRunId: 'wrun_1',
    });
  });

  it('refuses unknown runs, mismatched ids and stale attempts without starting anything', async () => {
    const job = await seedRun();
    const never = async () => {
      throw new Error('must not start');
    };
    expect(await startPipelineWorkflow(db, { ...job, pipelineRunId: newId() }, never)).toEqual({
      status: 'not_found',
    });
    expect(await startPipelineWorkflow(db, { ...job, workspaceId: newId() }, never)).toEqual({
      status: 'not_found',
    });
    expect(await startPipelineWorkflow(db, { ...job, meetingId: newId() }, never)).toEqual({
      status: 'not_found',
    });
    expect(await startPipelineWorkflow(db, { ...job, attempt: 2 }, never)).toEqual({
      status: 'superseded',
    });
    await db
      .update(pipelineRun)
      .set({ status: 'failed' })
      .where(eq(pipelineRun.id, job.pipelineRunId));
    expect(await startPipelineWorkflow(db, job, never)).toEqual({ status: 'superseded' });
  });

  it('starts after the claim commits: a failed start releases it, a dead claim is taken over', async () => {
    const job = await seedRun();
    // While start() runs, the row only holds a placeholder (the lock is already released).
    let seenDuringStart: string | null = null;
    await expect(
      startPipelineWorkflow(db, job, async () => {
        seenDuringStart = (await rowOf(job.pipelineRunId)).workflowRunId;
        throw new Error('world down');
      }),
    ).rejects.toThrow('world down');
    expect(seenDuringStart).toMatch(/^starting:/);
    expect(await rowOf(job.pipelineRunId)).toMatchObject({
      status: 'waiting',
      workflowRunId: null,
    });

    // A process that died between claim and start leaves a placeholder; after a minute it is taken over.
    await db
      .update(pipelineRun)
      .set({ workflowRunId: `starting:${Date.now() - 120_000}:dead` })
      .where(eq(pipelineRun.id, job.pipelineRunId));
    expect(await startPipelineWorkflow(db, job, async () => 'wrun_new')).toEqual({
      status: 'started',
      workflowRunId: 'wrun_new',
    });
    // A fresh placeholder makes repeats wait for the real id instead.
    const other = await seedRun();
    await db
      .update(pipelineRun)
      .set({ workflowRunId: `starting:${Date.now()}:live` })
      .where(eq(pipelineRun.id, other.pipelineRunId));
    // (Drizzle queries are lazy: `.then` runs it.)
    setTimeout(() => {
      db.update(pipelineRun)
        .set({ workflowRunId: 'wrun_live', status: 'queued' })
        .where(eq(pipelineRun.id, other.pipelineRunId))
        .then(
          () => undefined,
          () => undefined,
        );
    }, 300);
    expect(
      await startPipelineWorkflow(db, other, async () => {
        throw new Error('must not start');
      }),
    ).toEqual({ status: 'existing', workflowRunId: 'wrun_live' });
  });
});

describe('finishPipelineRun', () => {
  it('re-arms a run whose meeting ended again meanwhile; a fatal failure is final and not retryable', async () => {
    const job = await seedRun();
    await startPipelineWorkflow(db, job, async () => 'wrun');
    const ref = { pipelineRunId: job.pipelineRunId, attempt: 1 };
    await markPipelineStep(db, ref, 'enhance');
    await recordPipelineStep(db, ref, {
      step: 'enhance',
      outcome: 'ran',
      at: new Date().toISOString(),
    });
    await db
      .update(pipelineRun)
      .set({ rerunRequested: true })
      .where(eq(pipelineRun.id, job.pipelineRunId));
    expect(await finishPipelineRun(db, ref, { status: 'completed' })).toBe('rerun');
    expect(await rowOf(job.pipelineRunId)).toMatchObject({
      status: 'waiting',
      attempt: 2,
      steps: [],
      workflowRunId: null,
      rerunRequested: false,
    });
    expect(await finishPipelineRun(db, ref, { status: 'completed' })).toBe('stale');

    const owner = await seedRun();
    await startPipelineWorkflow(db, owner, async () => 'wrun2');
    await db
      .update(pipelineRun)
      .set({ rerunRequested: true })
      .where(eq(pipelineRun.id, owner.pipelineRunId));
    const ownerRef = { pipelineRunId: owner.pipelineRunId, attempt: 1 };
    expect(
      await finishPipelineRun(db, ownerRef, {
        status: 'failed',
        error: 'x',
        code: OWNER_NO_ACCESS,
      }),
    ).toBe('finished');
    const row = await rowOf(owner.pipelineRunId);
    expect(toPipelineRunDto(row)).toMatchObject({ status: 'failed', retryable: false, error: 'x' });
  });
});

describe('recoverStuckRuns', () => {
  it('settles quiet live runs from the world; leaves recent and still-running ones', async () => {
    const make = async (
      status: 'queued' | 'running',
      workflowRunId: string | null,
      quiet = true,
    ) => {
      const job = await seedRun();
      await db.execute(sql`update pipeline_run set status = ${status}, workflow_run_id = ${workflowRunId},
        updated_at = now() - make_interval(mins => ${quiet ? 20 : 1}) where id = ${job.pipelineRunId}`);
      return job.pipelineRunId;
    };
    const lost = await make('running', 'wrun_lost');
    const failed = await make('running', 'wrun_failed');
    const done = await make('running', 'wrun_done');
    const sleeping = await make('running', 'wrun_sleeping');
    const neverStarted = await make('queued', null);
    const recent = await make('running', 'wrun_recent', false);
    const states: Record<string, WorkflowRunState> = {
      wrun_lost: 'missing',
      wrun_failed: 'failed',
      wrun_done: 'completed',
      wrun_sleeping: 'running',
      wrun_recent: 'missing',
    };
    const asked: string[] = [];
    const totals = await recoverStuckRuns(
      db,
      async (id) => {
        asked.push(id);
        return states[id]!;
      },
      { limit: 100 },
    );
    expect(totals).toMatchObject({ failed: 2, completed: 1, requeued: 1, alive: 1 });
    expect(asked).not.toContain('wrun_recent');
    expect(toPipelineRunDto(await rowOf(lost))).toMatchObject({
      status: 'failed',
      error: STOPPED_MESSAGE,
      retryable: true,
    });
    expect((await rowOf(failed)).status).toBe('failed');
    expect((await rowOf(done)).status).toBe('completed');
    const alive = await rowOf(sleeping);
    expect(alive.status).toBe('running');
    expect(alive.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000); // looked at again later
    expect(await rowOf(neverStarted)).toMatchObject({ status: 'waiting', workflowRunId: null });
    expect((await rowOf(recent)).status).toBe('running');
  });
});

describe('step records', () => {
  it('mark → record (once per step, in order) → finish; a stale attempt writes nothing', async () => {
    const job = await seedRun();
    await startPipelineWorkflow(db, job, async () => 'wrun');
    const ref = { pipelineRunId: job.pipelineRunId, attempt: 1 };
    expect(await isCurrentAttempt(db, ref)).toBe(true);
    expect(await isCurrentAttempt(db, { ...ref, attempt: 2 })).toBe(false);

    await markPipelineStep(db, ref, 'enhance');
    let row = await rowOf(job.pipelineRunId);
    expect(row).toMatchObject({ status: 'running', currentStep: 'enhance' });
    expect(row.startedAt).toBeInstanceOf(Date);

    const at = new Date().toISOString();
    await recordPipelineStep(db, ref, { step: 'enhance', outcome: 'ran', at });
    await markPipelineStep(db, ref, 'index');
    await recordPipelineStep(db, ref, {
      step: 'index',
      outcome: 'ran',
      detail: { inserted: 3 },
      at,
    });
    // A re-run step (crash after its write) replaces its record instead of adding one.
    await recordPipelineStep(db, ref, { step: 'enhance', outcome: 'skipped', reason: 'x', at });
    row = await rowOf(job.pipelineRunId);
    expect(row.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['index', 'ran'],
      ['enhance', 'skipped'],
    ]);
    expect(row.currentStep).toBeNull();

    // A superseded attempt can't touch the row.
    await markPipelineStep(db, { ...ref, attempt: 2 }, 'notion');
    await finishPipelineRun(db, { ...ref, attempt: 2 }, { status: 'failed', error: 'old' });
    expect(await rowOf(job.pipelineRunId)).toMatchObject({ status: 'running', currentStep: null });

    await finishPipelineRun(db, ref, { status: 'completed' });
    row = await rowOf(job.pipelineRunId);
    expect(toPipelineRunDto(row)).toMatchObject({ status: 'completed', error: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
    // Finished is final: a replayed late write doesn't reopen it.
    await markPipelineStep(db, ref, 'notion');
    await finishPipelineRun(db, ref, { status: 'failed', error: 'late' });
    expect(await rowOf(job.pipelineRunId)).toMatchObject({ status: 'completed' });
  });
});
