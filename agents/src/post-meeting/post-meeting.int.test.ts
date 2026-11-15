/**
 * The post-meeting pipeline (8.2 spike → 8.3) end to end, offline (D-11): the real eve server (`eve build` +
 * the server `eve start` runs, with its schedules) on the Postgres Workflow world, a throwaway app database, the
 * compose Redis, and an in-process mocks server for the LLM (enhance + embeddings) and Notion. Runs are requested
 * the way the web app does (`@oat/services/pipeline` `requestPostMeeting` → HTTP `POST /jobs/post-meeting`) and
 * read back from `pipeline_run`; side effects are checked in Postgres and the mocks' request log.
 *
 * Covers: the /jobs contract (token rotation, workspace check, attempt fencing, dedupe); a full run and an
 * idempotent second attempt; auto-send off / not connected / auto-enhance off; a failing step → failed → retry;
 * the agents being down (run waits, the server's minute sweep hands it over once it is back); and a SIGKILL
 * *during a (slowed) enhance generation* and during a durable wait (the restarted server settles the orphaned
 * generation once stale, D-26, and finishes both runs), plus a run kept busy past its deadline. The server
 * runs with the D-29 defaults (30 s lock-stale window), so the crash case takes ~2 min.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encryptSecret, secretSourceFromEnv } from '@oat/auth';
import {
  actionItem,
  chunk,
  createDb,
  type Db,
  document,
  documentExport,
  enhancement,
  integration,
  meeting,
  membership,
  migrate,
  newId,
  participant,
  pipelineRun,
  type PipelineRunRow,
  pipelineSetting,
  transcriptSegment,
  user,
  workspace,
} from '@oat/db';
import { extractActionItems } from '@oat/indexing';
import { NOTION_MOCK_IDS, type RunningMocks, startMocks } from '@oat/mocks';
import { loadActor } from '@oat/services/actor';
import {
  createAgentsDispatcher,
  type PipelineDeps,
  type PostMeetingJob,
  requestPostMeeting,
  retryPostMeeting,
  toPipelineRunDto,
} from '@oat/services/pipeline';
import { createTestDatabase, type TestDatabase, waitFor } from '@oat/testkit';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapWorld } from '../cli/bootstrap-world.ts';
import { type AgentServer, buildAgent, devEnv, freePort, startAgent } from './int-server.ts';
import type { PostMeetingRun } from './types.ts';

let appDb: TestDatabase;
let worldDb: TestDatabase;
let db: Db;
let mocks: RunningMocks;
let server: AgentServer;
let serverEnv: Record<string, string>;
let port: number;
/** ≥ 32 characters (D-29); the previous one is still accepted during a rotation. */
const token = randomBytes(32).toString('base64url');
const previousToken = randomBytes(32).toString('base64url');
/** D-26 staleness for the server under test: longer than a restart takes (≈ 30–45 s), so the busy loop runs. */
const STALE_MS = 75_000;

/**
 * A pass-through in front of the mock LLM. While `llm.slow`, chat completions get the mock's `slow` scenario
 * (the generation hangs, so the server can be killed in the middle of one); while `llm.fail`, they fail (400,
 * so the AI SDK doesn't retry).
 */
const llm = { slow: false, fail: false, seen: 0 };
let proxy: Server;

function startLlmProxy(target: string): Promise<string> {
  proxy = createServer((req, res) => {
    const url = new URL(req.url ?? '/', target);
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: url.host,
    };
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      if (llm.slow) {
        llm.seen += 1;
        headers['x-mock-scenario'] = 'slow';
        headers['x-mock-delay-ms'] = '60000';
      } else if (llm.fail) {
        headers['x-mock-scenario'] = 'error';
        headers['x-mock-status'] = '400';
      }
    }
    const upstream = httpRequest(url, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) =>
    proxy.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`),
    ),
  );
}

/** The web app's side: requests go to the agents over HTTP, exactly like `apps/web` does. */
const pipeline = (): PipelineDeps => ({
  db,
  dispatcher: createAgentsDispatcher({ url: server.url, token, timeoutMs: 5_000 }),
  logError: () => {},
});

beforeAll(async () => {
  [appDb, worldDb, mocks] = await Promise.all([
    createTestDatabase(),
    createTestDatabase(),
    startMocks(),
  ]);
  await migrate(appDb.url);
  bootstrapWorld(worldDb.url, { quiet: true });
  db = createDb(appDb.url, { max: 4 });
  buildAgent();
  const llmUrl = await startLlmProxy(mocks.url);
  const dev = devEnv();
  serverEnv = {
    ...dev,
    DATABASE_URL: appDb.url,
    WORKFLOW_POSTGRES_URL: worldDb.url,
    // WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS: not set → the D-29 default (30 s) from agentServerEnv.
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: '8',
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: '10',
    REDIS_URL: process.env.REDIS_URL || dev.REDIS_URL || 'redis://localhost:63790',
    MOCKS_URL: mocks.url,
    AI_BASE_URL: `${llmUrl}/llm/v1`,
    AI_GATEWAY_API_KEY: '',
    VERCEL: '',
    VERCEL_OIDC_TOKEN: '',
    NOTION_BASE_URL: `${mocks.url}/notion`,
    NOTION_OAUTH_CLIENT_ID: '',
    BETTER_AUTH_SECRETS: '',
    OAT_AGENTS_TOKEN: token,
    OAT_AGENTS_TOKEN_PREVIOUS: previousToken,
    OAT_AGENTS_BUSY_RETRY_MS: '1000',
    // Test knobs for D-26 (production uses the web app's 2 min / 3 min); deadline = stale + 60 s.
    OAT_AGENTS_ENHANCE_STALE_MS: String(STALE_MS),
    OAT_AGENTS_ENHANCE_TIMEOUT_MS: '20000',
  };
  port = await freePort();
  server = await startAgent(serverEnv, port, { schedules: true });
}, 180_000);

afterAll(async () => {
  await server?.stop();
  proxy?.closeAllConnections();
  await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve(undefined)));
  await db?.$client.end();
  await mocks?.close();
  await appDb?.drop();
  await worldDb?.drop();
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures

const NOTES = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'pilot in two clinics' }] },
    // A task in the user's own notes: enhance keeps it (as a task), the index step turns it into an action item.
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Dana to send the security review' }],
            },
          ],
        },
      ],
    },
  ],
};

const SEGMENTS = [
  'Thanks for joining, let us talk about the clinic pilot.',
  'We want to start the pilot in two clinics next month.',
  'Dana will send the security review by Friday.',
  'Sam owns the onboarding plan for the clinic staff.',
];

/** A team workspace, its owner, an ended meeting note with notes + transcript, and a Notion connection. */
async function seedMeeting(
  options: { autoPush?: boolean; autoEnhance?: boolean; editor?: boolean } = {},
) {
  const ownerId = newId();
  await db.insert(user).values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Ada' });
  const workspaceId = newId();
  await db.insert(workspace).values({
    id: workspaceId,
    name: 'W',
    slug: `w-${workspaceId}`,
    createdBy: ownerId,
    kind: 'team',
  });
  await db.insert(membership).values({ workspaceId, userId: ownerId, role: 'owner' });
  const documentId = newId();
  await db.insert(document).values({
    id: documentId,
    workspaceId,
    ownerId,
    kind: 'meeting',
    title: 'Clinic pilot sync',
    // With an editor: shared with the workspace, so the editor can end/run it.
    visibility: options.editor ? 'workspace' : 'private',
    contentJson: NOTES,
  });
  const meetingId = newId();
  await db.insert(meeting).values({
    id: meetingId,
    documentId,
    // Ended a minute ago (enhancements made by the run come after the end).
    startedAt: new Date(Date.now() - 31 * 60_000),
    endedAt: new Date(Date.now() - 60_000),
    platform: 'zoom',
  });
  await db.insert(participant).values({ meetingId, name: 'Dana', source: 'manual' });
  await db.insert(transcriptSegment).values(
    SEGMENTS.map((text, i) => ({
      id: `${meetingId}-s${i}`,
      meetingId,
      source: i % 2 === 0 ? ('mic' as const) : ('system' as const),
      startMs: i * 5000,
      endMs: i * 5000 + 4500,
      text,
    })),
  );
  if (options.autoPush !== undefined) {
    // Encrypted like the web app does (its Better Auth secret config, rebuilt from the same env).
    await db.insert(integration).values({
      workspaceId,
      userId: ownerId,
      provider: 'notion',
      secretEncrypted: await encryptSecret(
        secretSourceFromEnv(serverEnv),
        `ntn_mock_${randomUUID()}`,
      ),
      settingsJson: {
        notionWorkspaceId: NOTION_MOCK_IDS.workspace,
        targetType: 'page',
        targetId: NOTION_MOCK_IDS.meetingNotes,
        targetTitle: 'Meeting notes',
        autoPush: options.autoPush,
      },
    });
  }
  if (options.autoEnhance !== undefined) {
    await db
      .insert(pipelineSetting)
      .values({ workspaceId, userId: ownerId, autoEnhance: options.autoEnhance });
  }
  let editorId: string | null = null;
  if (options.editor) {
    editorId = newId();
    await db.insert(user).values({ id: editorId, email: `${editorId}@example.test`, name: 'Ed' });
    await db.insert(membership).values({ workspaceId, userId: editorId, role: 'member' });
  }
  return { ownerId, workspaceId, documentId, meetingId, editorId };
}

type Seeded = Awaited<ReturnType<typeof seedMeeting>>;

// ---------------------------------------------------------------------------------------------------------
// The web app's side and the jobs API

/** What the web app does when the owner ends the meeting. */
async function request(m: Seeded, deps = pipeline()) {
  return requestPostMeeting(deps, await loadActor(db, m.ownerId), m.meetingId);
}

/** A run that exists but wasn't handed over (agents "not configured"), for posting jobs by hand. */
async function waitingJob(m: Seeded): Promise<PostMeetingJob> {
  const run = await request(m, { db, dispatcher: null });
  return {
    pipelineRunId: run.id,
    attempt: run.attempt,
    meetingId: m.meetingId,
    workspaceId: m.workspaceId,
  };
}

function postJob(body: unknown, bearer = token) {
  return fetch(`${server.url}/jobs/post-meeting`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const runRow = async (meetingId: string): Promise<PipelineRunRow> =>
  (await db.select().from(pipelineRun).where(eq(pipelineRun.meetingId, meetingId)))[0]!;

/** Waits until the meeting's run is finished (completed/failed), at `attempt` if given. */
async function finished(meetingId: string, timeout = 60_000, attempt?: number) {
  return waitFor(
    async () => {
      const row = await runRow(meetingId);
      const done = row && (row.status === 'completed' || row.status === 'failed');
      return done && (attempt === undefined || row.attempt === attempt) ? row : undefined;
    },
    { timeout, interval: 250 },
  ).catch(async (error: unknown) => {
    console.error(
      '[8.3] run did not finish:',
      JSON.stringify(await runRow(meetingId)),
      '\nserver output (tail):\n',
      server.output().slice(-6000),
    );
    throw error;
  });
}

type RunView = { runId: string; status: string; result: PostMeetingRun | null };

async function workflowRun(runId: string): Promise<RunView> {
  const res = await fetch(`${server.url}/jobs/post-meeting/runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as RunView;
}

const outcomes = (row: { steps: { step: string; outcome: string; reason?: string }[] }) =>
  Object.fromEntries(row.steps.map((s) => [s.step, s.reason ?? s.outcome]));

const enhancementsOf = (documentId: string) =>
  db.select().from(enhancement).where(eq(enhancement.documentId, documentId));
const exportsOf = (documentId: string) =>
  db.select().from(documentExport).where(eq(documentExport.documentId, documentId));
const hasNotesChunks = async (documentId: string) =>
  (await db.select().from(chunk).where(eq(chunk.documentId, documentId))).some(
    (c) => c.source === 'notes',
  ) || undefined;

const notionCreates = () =>
  mocks.log
    .list({ provider: 'notion' })
    .filter((r) => r.method === 'POST' && r.path === '/notion/v1/pages');

/** Sets a finished run back to `failed`, so the owner can run it again (a second attempt). */
async function markFailed(meetingId: string) {
  await db
    .update(pipelineRun)
    .set({ status: 'failed', error: 'test' })
    .where(eq(pipelineRun.meetingId, meetingId));
}

// ---------------------------------------------------------------------------------------------------------

describe('post-meeting pipeline on eve (offline)', () => {
  it('jobs contract (D-29): token, workspace, attempt fencing, one workflow per attempt', async () => {
    const m = await seedMeeting();
    const other = await seedMeeting();
    const job = await waitingJob(m);
    // Only the current or the previous service token.
    expect((await postJob(job, 'x'.repeat(43))).status).toBe(401);
    expect((await fetch(`${server.url}/jobs/post-meeting/x`)).status).toBe(401);
    // Every field is required; the workspace must be the meeting's and the run's; the attempt the current one.
    expect((await postJob({ ...job, workspaceId: undefined })).status).toBe(400);
    expect((await postJob({ ...job, workspaceId: other.workspaceId })).status).toBe(404);
    expect((await postJob({ ...job, meetingId: other.meetingId })).status).toBe(404);
    expect((await postJob({ ...job, pipelineRunId: newId() })).status).toBe(404);
    expect((await postJob({ ...job, attempt: 2 })).status).toBe(409);
    // The previous token still works during a rotation; a repeat gets the same Workflow run.
    const first = await postJob(job, previousToken);
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    const repeat = await postJob(job);
    expect(repeat.status).toBe(202);
    expect(((await repeat.json()) as { runId: string }).runId).toBe(runId);
    const row = await finished(m.meetingId);
    expect(row).toMatchObject({ status: 'completed', workflowRunId: runId });
    expect(await enhancementsOf(other.documentId)).toEqual([]);
  });

  it('enhances, indexes, pushes to Notion and records each step; a second attempt changes nothing', async () => {
    const m = await seedMeeting({ autoPush: true });
    const llmBefore = mocks.log.list({ provider: 'llm' }).length;
    const [seeded] = await db.select().from(document).where(eq(document.id, m.documentId));

    const requested = await request(m);
    expect(requested.status).toBe('queued');
    // Asking again (a second "meeting ended") returns the same run.
    expect((await request(m)).id).toBe(requested.id);

    const row = await finished(m.meetingId);
    expect(row.status, server.output()).toBe('completed');
    expect(row).toMatchObject({ attempt: 1, currentStep: null, error: null });
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(outcomes(row)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    const view = await workflowRun(row.workflowRunId!);
    expect(view.status).toBe('completed');
    expect(view.result).toMatchObject({ pipelineRunId: row.id, documentId: m.documentId });

    // (1) the enhance job ran as the owner and applied the enhanced body.
    const runs = await enhancementsOf(m.documentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      idempotencyKey: `${m.ownerId}:${m.documentId}:post-meeting:${row.workflowRunId}`,
    });
    expect((runs[0]!.outputJson as { applied: boolean }).applied).toBe(true);
    const [doc] = await db.select().from(document).where(eq(document.id, m.documentId));
    expect(doc!.version).toBe(seeded!.version + 1);
    expect(doc!.contentJson).not.toEqual(NOTES);
    // …through the mock LLM, over HTTP.
    expect(mocks.log.list({ provider: 'llm' }).length).toBeGreaterThan(llmBefore);

    // (2) the enhanced notes and the transcript are in the retrieval index, the action items in `action_item`.
    const chunks = await db.select().from(chunk).where(eq(chunk.documentId, m.documentId));
    expect(chunks.some((c) => c.source === 'notes')).toBe(true);
    expect(chunks.some((c) => c.source === 'transcript')).toBe(true);
    const expected = extractActionItems(doc!.contentJson);
    const items = await db.select().from(actionItem).where(eq(actionItem.documentId, m.documentId));
    expect(items.map((i) => i.text).sort()).toEqual(expected.map((i) => i.text).sort());
    expect(expected.length).toBeGreaterThan(0);
    expect(row.steps.find((s) => s.step === 'index')!.detail).toMatchObject({
      actionItemsWritten: expected.length,
    });

    // (3) one Notion page, recorded on document_export.
    const [exp] = await exportsOf(m.documentId);
    expect(exp?.externalId).toBeTruthy();
    expect(exp?.pushedVersion).toBe(doc!.version);

    // A second attempt: enhance is skipped, nothing is re-embedded, the same Notion page is updated.
    const creates = notionCreates().length;
    await markFailed(m.meetingId);
    const retried = await retryPostMeeting(
      pipeline(),
      await loadActor(db, m.ownerId),
      m.documentId,
    );
    expect(retried.run).toMatchObject({ attempt: 2, steps: [] });
    const again = await finished(m.meetingId, 60_000, 2);
    expect(again.status).toBe('completed');
    expect(outcomes(again)).toEqual({ enhance: 'already enhanced', index: 'ran', notion: 'ran' });
    expect(again.steps.find((s) => s.step === 'index')!.detail).toMatchObject({
      inserted: 0,
      deleted: 0,
      actionItemsWritten: 0,
    });
    expect(again.steps.find((s) => s.step === 'notion')!.detail).toMatchObject({ created: false });
    expect(notionCreates().length).toBe(creates);
    expect(await enhancementsOf(m.documentId)).toHaveLength(1);
  });

  it('a meeting resumed and ended again runs again: re-enhanced, re-indexed, the same Notion page updated', async () => {
    const m = await seedMeeting({ autoPush: true });
    await request(m);
    const first = await finished(m.meetingId);
    expect(outcomes(first)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });

    // Resumed (D-24): ended_at cleared, more transcript, ended again.
    await db.update(meeting).set({ endedAt: null }).where(eq(meeting.id, m.meetingId));
    await db.insert(transcriptSegment).values({
      id: `${m.meetingId}-s9`,
      meetingId: m.meetingId,
      source: 'mic',
      startMs: 60_000,
      endMs: 64_000,
      text: 'One more thing: Sam will book the clinic visit for Tuesday.',
    });
    await db.update(meeting).set({ endedAt: new Date() }).where(eq(meeting.id, m.meetingId));
    const creates = notionCreates().length;
    expect((await request(m)).attempt).toBe(2);
    const second = await finished(m.meetingId, 60_000, 2);
    expect(second.status).toBe('completed');
    // The earlier enhancement predates this end: enhanced again (with the new part of the transcript).
    expect(outcomes(second)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    const done = (await enhancementsOf(m.documentId)).filter((e) => e.status === 'completed');
    expect(done).toHaveLength(2);
    expect(second.steps.find((s) => s.step === 'notion')!.detail).toMatchObject({ created: false });
    expect(notionCreates().length).toBe(creates);
  });

  it('an owner who can no longer edit the note stops the run for good (no step retries, no Retry)', async () => {
    const m = await seedMeeting({ editor: true });
    await db
      .update(membership)
      .set({ role: 'viewer' })
      .where(and(eq(membership.workspaceId, m.workspaceId), eq(membership.userId, m.ownerId)));
    // The editor ends it (they may), but the pipeline acts as the owner.
    await requestPostMeeting(pipeline(), await loadActor(db, m.editorId!), m.meetingId);
    const row = await finished(m.meetingId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'owner_no_access', steps: [] });
    expect(toPipelineRunDto(row)).toMatchObject({ retryable: false });
    expect(row.error).toMatch(/owner can no longer edit/);
    expect(await enhancementsOf(m.documentId)).toEqual([]);
  });

  it('runs whose workflow stopped or finished unrecorded are settled by the sweep; retry then works', async () => {
    const lost = await seedMeeting({ autoPush: false });
    const unrecorded = await seedMeeting({ autoPush: false });
    await Promise.all([request(lost), request(unrecorded)]);
    const [a, b] = await Promise.all([finished(lost.meetingId), finished(unrecorded.meetingId)]);
    expect([a.status, b.status]).toEqual(['completed', 'completed']);
    // (a) Looks live, but the world has no such run (wiped world, eve upgrade); (b) the world completed it but
    // the finish step's write never landed. Both quiet for 20 min.
    await db.execute(sql`update pipeline_run set status = 'running', current_step = 'enhance',
      workflow_run_id = ${`wrun_gone_${randomUUID()}`},
      updated_at = now() - interval '20 minutes' where id = ${a.id}`);
    await db.execute(sql`update pipeline_run set status = 'running', finished_at = null,
      updated_at = now() - interval '20 minutes' where id = ${b.id}`);
    // The server's minute sweep settles both.
    const settledA = await finished(lost.meetingId, 90_000);
    expect(settledA).toMatchObject({
      status: 'failed',
      error: 'The post-meeting steps stopped. Try again.',
    });
    expect(toPipelineRunDto(settledA)).toMatchObject({ retryable: true });
    expect((await finished(unrecorded.meetingId, 90_000)).status).toBe('completed');
    // Retry runs the next attempt to the end.
    const retried = await retryPostMeeting(
      pipeline(),
      await loadActor(db, lost.ownerId),
      lost.documentId,
    );
    expect(retried.run).toMatchObject({ attempt: 2 });
    expect((await finished(lost.meetingId, 60_000, 2)).status).toBe('completed');
  }, 180_000);

  it('respects the switches: Notion auto-send off / not connected, auto-enhance off', async () => {
    const off = await seedMeeting({ autoPush: false });
    const none = await seedMeeting();
    const raw = await seedMeeting({ autoPush: true, autoEnhance: false });
    await Promise.all([request(off), request(none), request(raw)]);
    const [a, b, c] = await Promise.all([
      finished(off.meetingId),
      finished(none.meetingId),
      finished(raw.meetingId),
    ]);
    expect(outcomes(a)).toEqual({ enhance: 'ran', index: 'ran', notion: 'auto-push off' });
    expect(outcomes(b)).toEqual({ enhance: 'ran', index: 'ran', notion: 'not connected' });
    // Not enhanced: the notes as written are indexed and sent.
    expect(outcomes(c)).toEqual({ enhance: 'auto-enhance off', index: 'ran', notion: 'ran' });
    expect(await enhancementsOf(raw.documentId)).toEqual([]);
    expect(await exportsOf(raw.documentId)).toHaveLength(1);
    expect(await exportsOf(off.documentId)).toEqual([]);
  });

  it('a step that keeps failing fails the run with a clear message; retry runs it again', async () => {
    const m = await seedMeeting({ autoPush: true });
    llm.fail = true;
    try {
      await request(m);
      const failed = await finished(m.meetingId);
      expect(failed).toMatchObject({ status: 'failed', attempt: 1, currentStep: null });
      expect(failed.error).toBe('Enhancing the notes failed. Try again.');
      expect(failed.steps).toEqual([]);
      // Every attempt of the step was a fresh, failed enhancement (no half-applied note); nothing was sent.
      const tries = await enhancementsOf(m.documentId);
      expect(tries.length).toBeGreaterThan(1);
      expect(tries.every((t) => t.status === 'failed')).toBe(true);
      expect(await exportsOf(m.documentId)).toEqual([]);
    } finally {
      llm.fail = false;
    }
    await retryPostMeeting(pipeline(), await loadActor(db, m.ownerId), m.documentId);
    const ok = await finished(m.meetingId, 60_000, 2);
    expect(ok.status).toBe('completed');
    expect(outcomes(ok)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    expect(
      (await enhancementsOf(m.documentId)).filter((e) => e.status === 'completed'),
    ).toHaveLength(1);
    expect(await exportsOf(m.documentId)).toHaveLength(1);
  });

  it('survives a SIGKILL mid-generation and mid-wait; a run asked for while down waits for the sweep; a busy run fails at its deadline', async () => {
    // (c) Busy forever: another push holds this note's Notion lease. Started first, it fails last.
    const leased = await seedMeeting({ autoPush: true });
    const [integ] = await db
      .select()
      .from(integration)
      .where(eq(integration.workspaceId, leased.workspaceId));
    await db.insert(documentExport).values({
      documentId: leased.documentId,
      integrationId: integ!.id,
      leaseId: 'someone-else',
      leaseUntil: new Date(Date.now() + 60 * 60_000),
    });
    await request(leased);

    // (b) In the durable wait between indexing and the push when the server dies.
    const waiting = await seedMeeting({ autoPush: true });
    const waitingJobBody = await waitingJob(waiting);
    expect((await postJob({ ...waitingJobBody, pushDelayMs: 8_000 })).status).toBe(202);
    await waitFor(() => hasNotesChunks(waiting.documentId), { timeout: 30_000, interval: 100 });
    await new Promise((r) => setTimeout(r, 1_000)); // the index step's result is recorded; now sleeping

    // (a) In the middle of its enhance generation when the server dies (the mock LLM hangs).
    const generating = await seedMeeting({ autoPush: true });
    llm.slow = true;
    const seen = llm.seen;
    await request(generating);
    const [orphan] = await waitFor(
      async () => {
        const rows = await enhancementsOf(generating.documentId);
        return llm.seen > seen && rows[0]?.status === 'generating' ? rows : undefined;
      },
      { timeout: 30_000, interval: 100 },
    );
    expect((await runRow(generating.meetingId)).currentStep).toBe('enhance');
    await new Promise((r) => setTimeout(r, 500));

    await server.kill();
    llm.slow = false;
    // Really gone (the new server below must not be confused with a survivor on the same port).
    await expect(fetch(`${server.url}/eve/v1/health`)).rejects.toThrow();
    expect(await exportsOf(waiting.documentId)).toEqual([]); // killed before the push
    expect((await enhancementsOf(generating.documentId)).map((r) => r.status)).toEqual([
      'generating',
    ]);

    // (d) The meeting ends while the agents are down: the run waits ("waiting for the pipeline").
    const late = await seedMeeting({ autoPush: true });
    const lateRun = await request(late);
    expect(lateRun.status).toBe('waiting');
    expect((await runRow(late.meetingId)).dispatchError).toMatch(/unreachable/);

    server = await startAgent(serverEnv, port, { schedules: true });

    // (d) The server's minute sweep hands it over (nobody else asks), and it completes.
    const d = await finished(late.meetingId, 150_000);
    expect(d.status).toBe('completed');
    expect(outcomes(d)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    expect(d.dispatchAttempts).toBe(2); // the failed hand-over + the sweep's

    // (a) The orphaned generation stays `generating` until D-26 staleness: the step answers busy, the workflow
    // sleeps and asks again; once stale it is settled as failed and a fresh run is applied.
    const a = await finished(generating.meetingId, 180_000);
    expect(a.status, server.output()).toBe('completed');
    expect(outcomes(a)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    const enhance = a.steps.find((s) => s.step === 'enhance')!;
    expect(Number(enhance.detail?.waitedMs)).toBeGreaterThan(0);
    const runs = await enhancementsOf(generating.documentId);
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
    const failed = runs.find((r) => r.status === 'failed')!;
    expect(failed.id).toBe(orphan!.id);
    expect((failed.outputJson as { error: { code: string } }).error.code).toBe('stale');
    const applied = runs.filter((r) => (r.outputJson as { applied?: boolean }).applied === true);
    expect(applied).toHaveLength(1);
    expect(await exportsOf(generating.documentId)).toHaveLength(1);

    // (b) Completed steps were not repeated: one enhancement, one push after the restart.
    const b = await finished(waiting.meetingId, 60_000);
    expect(b.status).toBe('completed');
    expect(outcomes(b)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    expect(await enhancementsOf(waiting.documentId)).toHaveLength(1);
    expect((await exportsOf(waiting.documentId))[0]?.externalId).toBeTruthy();

    // (c) Busy past the deadline (stale + 60 s): failed with the reason, steps so far kept.
    const c = await finished(leased.meetingId, 120_000);
    expect(c.status).toBe('failed');
    expect(c.steps.map((s) => s.step)).toEqual(['enhance', 'index']);
    expect(c.error).toBe('Sending to Notion stayed blocked by another send. Try again.');
    const view = await workflowRun(c.workflowRunId!);
    expect(view.status).toBe('failed');
  }, 420_000);
});
