/**
 * Post-meeting pipeline (8.3) through the exact route handlers, against a throwaway database and an in-process
 * Better Auth: the trigger (a desktop sync push that ends a meeting), authorization and idempotency of the
 * request, the hand-over to the agents (a recording fake here; the real agents server is covered by
 * `agents/src/post-meeting/post-meeting.int.test.ts`), the agents being down ("waiting" + the backstop sweep),
 * retry, and the per-user settings. Deny cases carry `denies(...)` markers (5.5).
 */
import { findPersonalWorkspaceId } from '@oat/auth';
import type { SyncPushEntry, SyncPushResponse } from '@oat/core';
import { integration, pipelineRun } from '@oat/db';
import { loadActor } from '@oat/services/actor';
import {
  DispatchError,
  finishPipelineRun,
  OWNER_NO_ACCESS,
  type PipelineDeps,
  type PipelineDispatcher,
  type PostMeetingJob,
  requestPostMeeting,
  sweepPipelineRuns,
} from '@oat/services/pipeline';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PipelineRunResponse, PipelineSettingsDto } from '@/lib/pipeline';

import { denies } from '../api/authz-markers';
import { call, createHarness, type Harness, type TestUser } from '../api/test-harness';
import { createSyncApi, type SyncApi } from '../sync/api';
import { createPipelineApi, type PipelineApi } from './api';

let h: Harness;
let api: PipelineApi;
let sync: SyncApi;
let owner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;
let ownerPersonal: string;

/** The agents, as the web app sees them: up (records jobs, answers a run id) or down. */
const agents = {
  up: true,
  refuse: false,
  jobs: [] as PostMeetingJob[],
};
const dispatcher: PipelineDispatcher = {
  async dispatch(job) {
    if (!agents.up) throw new DispatchError('agents unreachable: connect ECONNREFUSED');
    if (agents.refuse) throw new DispatchError('agents answered 404 not_found', true);
    agents.jobs.push(job);
    return { workflowRunId: `wrun_${job.pipelineRunId}_${job.attempt}` };
  },
};
const deps = (): PipelineDeps => ({ db: h.db, dispatcher, logError: () => {} });
/** Meetings the sync hook reported, and the runs it started (like `after()` in production). */
const triggered: Promise<unknown>[] = [];

beforeAll(async () => {
  h = await createHarness();
  const apiDeps = {
    db: () => h.db,
    getSession: (headers: Headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => ['http://localhost:3000'],
  };
  api = createPipelineApi(apiDeps, deps);
  sync = createSyncApi(apiDeps, {
    onMeetingEnded: (actor, meetingId) => {
      triggered.push(requestPostMeeting(deps(), actor, meetingId));
    },
  });
  [owner, editor, viewer, outsider] = await Promise.all([
    h.signUp('pl-owner'),
    h.signUp('pl-editor'),
    h.signUp('pl-viewer'),
    h.signUp('pl-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [editor, 'member'],
    [viewer, 'viewer'],
  ]);
  ownerPersonal = (await findPersonalWorkspaceId(h.db, owner.id))!;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  agents.up = true;
  agents.refuse = false;
  agents.jobs = [];
  triggered.length = 0;
});

let counter = 0;
let version = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++counter}`;

function push(as: TestUser, entries: SyncPushEntry[]) {
  return call<SyncPushResponse>(sync.push.POST, 'POST', '/api/sync/push', {
    as,
    bearer: true,
    origin: null,
    body: { entries },
  });
}

const docEntry = (id: string, workspaceId: string): SyncPushEntry => ({
  version: ++version,
  op: 'upsert',
  table: 'document',
  baseVersion: 0,
  row: {
    id,
    workspaceId,
    kind: 'meeting',
    title: 'Standup',
    contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
  },
});

const meetingEntry = (id: string, documentId: string, endedAt: string | null): SyncPushEntry => ({
  version: ++version,
  op: 'upsert',
  table: 'meeting',
  row: {
    id,
    documentId,
    calendarEventId: null,
    startedAt: '2026-11-15T10:00:00.000Z',
    endedAt,
    platform: null,
  },
});

/** A meeting note pushed like the desktop does: recording (not ended yet). */
async function recording(as: TestUser, workspaceId: string, shared = false) {
  const documentId = uid('doc');
  const meetingId = uid('mtg');
  const res = await push(as, [
    docEntry(documentId, workspaceId),
    meetingEntry(meetingId, documentId, null),
  ]);
  expect(res.body.results.map((r) => r.status)).toEqual(['ok', 'ok']);
  if (shared) {
    await h.db.execute(sql`update document set visibility = 'workspace' where id = ${documentId}`);
  }
  return { documentId, meetingId };
}

async function end(
  as: TestUser,
  m: { documentId: string; meetingId: string },
  at = '2026-11-15T10:30:00.000Z',
) {
  const res = await push(as, [meetingEntry(m.meetingId, m.documentId, at)]);
  expect(res.body.results[0]?.status).toBe('ok');
  await Promise.all(triggered);
}

const runOf = async (meetingId: string) =>
  (await h.db.select().from(pipelineRun).where(eq(pipelineRun.meetingId, meetingId)))[0];

const getRun = (as: TestUser | null, documentId: string) =>
  call<PipelineRunResponse>(api.run.GET, 'GET', `/api/documents/${documentId}/pipeline`, {
    as,
    params: { id: documentId },
  });
const postRun = (as: TestUser | null, documentId: string, origin?: string | null) =>
  call<PipelineRunResponse>(api.run.POST, 'POST', `/api/documents/${documentId}/pipeline`, {
    as,
    params: { id: documentId },
    ...(origin !== undefined ? { origin } : {}),
  });

describe('trigger: a sync push that ends a meeting', () => {
  it('starts one run when the meeting ends, hands it over once, and never again', async () => {
    const m = await recording(owner, ownerPersonal);
    expect(triggered).toHaveLength(0); // still recording
    expect(await runOf(m.meetingId)).toBeUndefined();

    await end(owner, m);
    const run = await runOf(m.meetingId);
    expect(run).toMatchObject({
      status: 'queued',
      attempt: 1,
      documentId: m.documentId,
      workspaceId: ownerPersonal,
      requestedBy: owner.id,
      workflowRunId: expect.stringMatching(/^wrun_/),
    });
    expect(agents.jobs).toEqual([
      {
        pipelineRunId: run!.id,
        attempt: 1,
        meetingId: m.meetingId,
        workspaceId: ownerPersonal,
      },
    ]);

    // The same end pushed again (outbox replay), and a direct request: the same run, no second hand-over.
    triggered.length = 0;
    await end(owner, m);
    expect(triggered).toHaveLength(0);
    const again = await requestPostMeeting(deps(), await loadActor(h.db, owner.id), m.meetingId);
    expect(again.id).toBe(run!.id);
    expect(agents.jobs).toHaveLength(1);

    const status = await getRun(owner, m.documentId);
    expect(status.status).toBe(200);
    expect(status.body.run).toMatchObject({ id: run!.id, status: 'queued', steps: [] });
  });

  it('an editor of a shared team note can end it; the run carries the workspace that was checked', async () => {
    const m = await recording(owner, team, true);
    await end(editor, m);
    expect(await runOf(m.meetingId)).toMatchObject({
      status: 'queued',
      workspaceId: team,
      requestedBy: editor.id,
    });
  });
});

describe('authorization', () => {
  it('reads need read access; start/retry needs edit access (owner/editor)', async () => {
    denies('GET /api/documents/[id]/pipeline', 'POST /api/documents/[id]/pipeline');
    const shared = await recording(owner, team, true);
    await h.db.execute(sql`update meeting set ended_at = now() where id = ${shared.meetingId}`);
    // Anonymous, outsiders (no existence leak), cross-site cookie writes.
    expect((await getRun(null, shared.documentId)).status).toBe(401);
    expect((await getRun(outsider, shared.documentId)).status).toBe(404);
    expect((await postRun(outsider, shared.documentId)).status).toBe(404);
    expect((await postRun(owner, shared.documentId, 'https://evil.example')).status).toBe(403);
    // A viewer sees the status but can't start it.
    expect((await getRun(viewer, shared.documentId)).body).toEqual({
      run: null,
      meetingEnded: true,
      canRun: false,
    });
    const refused = await postRun(viewer, shared.documentId);
    expect(refused.status).toBe(403);
    expect(await runOf(shared.meetingId)).toBeUndefined();
    expect(agents.jobs).toEqual([]);

    // The owner's private note in the same workspace: another member can't see it at all.
    const mine = await recording(owner, team);
    await h.db.execute(sql`update meeting set ended_at = now() where id = ${mine.meetingId}`);
    expect((await getRun(editor, mine.documentId)).status).toBe(404);
    expect((await postRun(editor, mine.documentId)).status).toBe(404);

    // The editor may start the shared one.
    const ok = await postRun(editor, shared.documentId);
    expect(ok.status).toBe(200);
    expect(ok.body.run).toMatchObject({ status: 'queued', attempt: 1 });
  });

  it('a meeting that hasn’t ended can’t be started', async () => {
    const m = await recording(owner, ownerPersonal);
    const res = await postRun(owner, m.documentId);
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe('meeting_not_ended');
  });
});

describe('agents down, refused, retry', () => {
  it('waits while the agents are down; the sweep (or a status read) hands it over later', async () => {
    agents.up = false;
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    const waiting = await runOf(m.meetingId);
    expect(waiting).toMatchObject({ status: 'waiting', dispatchAttempts: 1, workflowRunId: null });
    expect(waiting!.dispatchError).toMatch(/unreachable/);
    expect(waiting!.nextDispatchAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await getRun(owner, m.documentId)).body.run).toMatchObject({
      status: 'waiting',
      error: null, // internal hand-over errors aren't shown
    });

    // Not due yet: neither the sweep nor a read tries again.
    agents.up = true;
    expect(await sweepPipelineRuns(deps())).toEqual({ dispatched: 0, waiting: 0 });
    expect((await getRun(owner, m.documentId)).body.run?.status).toBe('waiting');
    expect(agents.jobs).toEqual([]);

    // Due: the sweep hands it over (once, even with two sweepers at the same moment).
    await h.db
      .update(pipelineRun)
      .set({ nextDispatchAt: new Date(Date.now() - 1000) })
      .where(eq(pipelineRun.meetingId, m.meetingId));
    const [a, b] = await Promise.all([sweepPipelineRuns(deps()), sweepPipelineRuns(deps())]);
    expect(a.dispatched + b.dispatched).toBe(1);
    expect(agents.jobs).toHaveLength(1);
    expect(await runOf(m.meetingId)).toMatchObject({ status: 'queued', dispatchError: null });
  });

  it('a status read hands over a due waiting run (the meeting header recovers by itself)', async () => {
    agents.up = false;
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    agents.up = true;
    await h.db
      .update(pipelineRun)
      .set({ nextDispatchAt: null })
      .where(eq(pipelineRun.meetingId, m.meetingId));
    expect((await getRun(owner, m.documentId)).body.run?.status).toBe('queued');
    expect(agents.jobs).toHaveLength(1);
  });

  it('a job the agents refuse fails the run; retry runs the next attempt', async () => {
    agents.refuse = true;
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    const failed = await getRun(owner, m.documentId);
    expect(failed.body.run).toMatchObject({ status: 'failed', attempt: 1 });
    expect(failed.body.run?.error).toBeTruthy();

    agents.refuse = false;
    // Retrying needs edit access too.
    expect((await postRun(outsider, m.documentId)).status).toBe(404);
    const retried = await postRun(owner, m.documentId);
    expect(retried.status).toBe(200);
    expect(retried.body.run).toMatchObject({
      status: 'queued',
      attempt: 2,
      error: null,
      steps: [],
    });
    expect(agents.jobs).toEqual([
      expect.objectContaining({ pipelineRunId: retried.body.run!.id, attempt: 2 }),
    ]);
    // Retrying a live run changes nothing (a double click).
    const again = await postRun(owner, m.documentId);
    expect(again.body.run).toMatchObject({ status: 'queued', attempt: 2 });
    expect(agents.jobs).toHaveLength(1);
  });

  it('with no agents configured the run waits (never fails)', async () => {
    const m = await recording(owner, ownerPersonal);
    await h.db.execute(sql`update meeting set ended_at = now() where id = ${m.meetingId}`);
    const run = await requestPostMeeting(
      { db: h.db, dispatcher: null },
      await loadActor(h.db, owner.id),
      m.meetingId,
    );
    expect(run.status).toBe('waiting');
    expect((await runOf(m.meetingId))!.dispatchError).toMatch(/not configured/);
  });
});

describe('resumed meetings, stuck and final failures, ended before 8.3', () => {
  /** What the agents would record when an attempt ends. */
  const finish = (
    row: { id: string; attempt: number },
    status: 'completed' | 'failed' = 'completed',
  ) =>
    finishPipelineRun(
      h.db,
      { pipelineRunId: row.id, attempt: row.attempt },
      status === 'completed'
        ? { status }
        : { status, error: 'Enhancing the notes failed. Try again.' },
    );

  it('a meeting resumed and ended again runs again (next attempt); a live run is re-run when it finishes', async () => {
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    const first = (await runOf(m.meetingId))!;
    expect(first).toMatchObject({ attempt: 1, status: 'queued' });
    expect(first.endedAt?.toISOString()).toBe('2026-11-15T10:30:00.000Z');
    await h.db.update(pipelineRun).set({ status: 'running' }).where(eq(pipelineRun.id, first.id));
    expect(await finish(first)).toBe('finished');

    // Resumed (D-24: the desktop clears ended_at): nothing happens yet.
    triggered.length = 0;
    await push(owner, [meetingEntry(m.meetingId, m.documentId, null)]);
    await Promise.all(triggered);
    expect(triggered).toHaveLength(0);
    expect((await getRun(owner, m.documentId)).body).toMatchObject({
      meetingEnded: false,
      run: { status: 'completed', attempt: 1 },
    });

    // Ended again: the finished run becomes attempt 2 and is handed over.
    await end(owner, m, '2026-11-15T11:30:00.000Z');
    const second = (await runOf(m.meetingId))!;
    expect(second).toMatchObject({
      attempt: 2,
      status: 'queued',
      steps: [],
      rerunRequested: false,
    });
    expect(second.endedAt?.toISOString()).toBe('2026-11-15T11:30:00.000Z');
    expect(agents.jobs.map((j) => j.attempt)).toEqual([1, 2]);
    // The same end again (an outbox replay) changes nothing.
    await requestPostMeeting(deps(), await loadActor(h.db, owner.id), m.meetingId);
    expect((await runOf(m.meetingId))!.attempt).toBe(2);

    // While attempt 2 is running, the meeting is resumed and ended once more: flagged, not handed over…
    await h.db.update(pipelineRun).set({ status: 'running' }).where(eq(pipelineRun.id, second.id));
    await push(owner, [meetingEntry(m.meetingId, m.documentId, null)]);
    await end(owner, m, '2026-11-15T12:30:00.000Z');
    expect(await runOf(m.meetingId)).toMatchObject({ attempt: 2, rerunRequested: true });
    expect(agents.jobs).toHaveLength(2);
    // …and when attempt 2 finishes, it becomes attempt 3 (waiting for the hand-over sweep).
    expect(await finish(second)).toBe('rerun');
    expect(await runOf(m.meetingId)).toMatchObject({ attempt: 3, status: 'waiting' });
    expect(await sweepPipelineRuns(deps())).toMatchObject({ dispatched: 1 });
    expect(agents.jobs.map((j) => j.attempt)).toEqual([1, 2, 3]);
  });

  it('retry on a waiting run never skips the backoff or a hand-over in flight', async () => {
    agents.up = false;
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    agents.up = true;
    expect((await postRun(owner, m.documentId)).body.run?.status).toBe('waiting');
    expect(agents.jobs).toEqual([]);
    expect((await runOf(m.meetingId))!.dispatchAttempts).toBe(1);
  });

  it('a failure no retry can fix offers no retry', async () => {
    const m = await recording(owner, ownerPersonal);
    await end(owner, m);
    const row = (await runOf(m.meetingId))!;
    await h.db.update(pipelineRun).set({ status: 'running' }).where(eq(pipelineRun.id, row.id));
    await finishPipelineRun(
      h.db,
      { pipelineRunId: row.id, attempt: 1 },
      { status: 'failed', error: 'The note’s owner can no longer edit it.', code: OWNER_NO_ACCESS },
    );
    const view = await getRun(owner, m.documentId);
    expect(view.body.run).toMatchObject({ status: 'failed', retryable: false });
    const again = await postRun(owner, m.documentId);
    expect(again.body.run).toMatchObject({ status: 'failed', attempt: 1 });
    expect(agents.jobs).toHaveLength(1);
  });

  it('a meeting that ended without a run can be started by its editors (the header offers "Run")', async () => {
    const m = await recording(owner, team, true);
    // Ended, but no run was ever made (e.g. it ended before 8.3).
    await h.db.execute(sql`update meeting set ended_at = now() where id = ${m.meetingId}`);
    expect((await getRun(viewer, m.documentId)).body).toEqual({
      run: null,
      meetingEnded: true,
      canRun: false,
    });
    expect((await getRun(editor, m.documentId)).body).toEqual({
      run: null,
      meetingEnded: true,
      canRun: true,
    });
    const started = await postRun(editor, m.documentId);
    expect(started.body).toMatchObject({ run: { status: 'queued' }, canRun: true });
    // Still recording: nothing to run, nothing offered.
    const live = await recording(owner, team, true);
    expect((await getRun(editor, live.documentId)).body).toEqual({
      run: null,
      meetingEnded: false,
      canRun: false,
    });
  });
});

describe('settings', () => {
  const getSettings = (as: TestUser | null, workspaceId: string) =>
    call<PipelineSettingsDto>(
      api.settings.GET,
      'GET',
      `/api/settings/pipeline?workspaceId=${workspaceId}`,
      { as },
    );
  const putSettings = (as: TestUser | null, body: unknown) =>
    call<PipelineSettingsDto>(api.settings.PUT, 'PUT', '/api/settings/pipeline', { as, body });

  it('defaults: auto-enhance on, Notion auto-send unavailable until connected', async () => {
    expect((await getSettings(editor, team)).body).toEqual({
      workspaceId: team,
      autoEnhance: true,
      autoSendToNotion: null,
    });
  });

  it('members change their own switches only; outsiders get 404', async () => {
    denies('GET /api/settings/pipeline', 'PUT /api/settings/pipeline');
    expect((await getSettings(outsider, team)).status).toBe(404);
    expect((await putSettings(outsider, { workspaceId: team, autoEnhance: false })).status).toBe(
      404,
    );
    expect((await putSettings(null, { workspaceId: team, autoEnhance: false })).status).toBe(401);

    const off = await putSettings(editor, { workspaceId: team, autoEnhance: false });
    expect(off.body).toMatchObject({ autoEnhance: false });
    // Someone else's settings in the same workspace are untouched.
    expect((await getSettings(owner, team)).body.autoEnhance).toBe(true);
    expect(
      (await putSettings(editor, { workspaceId: team, autoEnhance: true })).body,
    ).toMatchObject({ autoEnhance: true });
    expect((await putSettings(editor, { workspaceId: team, bogus: 1 })).status).toBe(400);
  });

  it('Notion auto-send needs a connection and keeps the connection’s other settings', async () => {
    const refused = await putSettings(owner, { workspaceId: team, autoSendToNotion: true });
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('notion_not_connected');

    await h.db.insert(integration).values({
      workspaceId: team,
      userId: owner.id,
      provider: 'notion',
      settingsJson: { targetType: 'page', targetId: 'p1', targetTitle: 'Meeting notes' },
    });
    expect((await getSettings(owner, team)).body.autoSendToNotion).toBe(false);
    const on = await putSettings(owner, { workspaceId: team, autoSendToNotion: true });
    expect(on.body).toMatchObject({ autoSendToNotion: true, autoEnhance: true });
    const [row] = await h.db.select().from(integration).where(eq(integration.userId, owner.id));
    expect(row!.settingsJson).toEqual({
      targetType: 'page',
      targetId: 'p1',
      targetTitle: 'Meeting notes',
      autoPush: true,
    });
    // The editor has no connection of their own: theirs is still "not connected".
    expect((await getSettings(editor, team)).body.autoSendToNotion).toBeNull();
  });
});
