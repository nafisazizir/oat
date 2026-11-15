/**
 * The post-meeting spike (8.2) end to end, offline (D-11): the real eve server (`eve build` + `eve start`) on the
 * Postgres Workflow world, a throwaway app database, the compose Redis, and an in-process mocks server for the
 * LLM (enhance + embeddings) and Notion. The workflow is started over the jobs route and read back from the
 * Workflow world; side effects are checked in Postgres and the mocks' request log. Includes a SIGKILL of the
 * server *during a (slowed) enhance generation* and during a durable wait: the restarted server settles the
 * orphaned generation once it is stale (D-26), starts a fresh one and finishes both runs; and a run kept busy
 * past its deadline fails with a clear message. The server runs with the D-29 defaults (30 s lock-stale window),
 * so the crash case takes ~2 min.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authConfigFromEnv, createAuth, encryptSecret } from '@oat/auth';
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
  transcriptSegment,
  user,
  workspace,
} from '@oat/db';
import { extractActionItems } from '@oat/indexing';
import { NOTION_MOCK_IDS, type RunningMocks, startMocks } from '@oat/mocks';
import { createTestDatabase, type TestDatabase, waitFor } from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { createClient } from 'redis';
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
const runLogPrefix = `oat-test:agents:${randomUUID()}`;
/** D-26 staleness for the server under test: longer than a restart takes (≈ 30–45 s), so the busy loop runs. */
const STALE_MS = 75_000;

/**
 * A pass-through in front of the mock LLM. While `slow.on`, chat completions get the mock's `slow` scenario
 * (the generation hangs), so the server can be killed in the middle of one.
 */
const slow = { on: false, seen: 0 };
let proxy: Server;

function startLlmProxy(target: string): Promise<string> {
  proxy = createServer((req, res) => {
    const url = new URL(req.url ?? '/', target);
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: url.host,
    };
    if (slow.on && req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      slow.seen += 1;
      headers['x-mock-scenario'] = 'slow';
      headers['x-mock-delay-ms'] = '60000';
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

beforeAll(async () => {
  [appDb, worldDb, mocks] = await Promise.all([
    createTestDatabase(),
    createTestDatabase(),
    startMocks(),
  ]);
  await migrate(appDb.url);
  bootstrapWorld(worldDb.url);
  db = createDb(appDb.url, { max: 4 });
  buildAgent();
  const llm = await startLlmProxy(mocks.url);
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
    AI_BASE_URL: `${llm}/llm/v1`,
    AI_GATEWAY_API_KEY: '',
    VERCEL: '',
    VERCEL_OIDC_TOKEN: '',
    NOTION_BASE_URL: `${mocks.url}/notion`,
    NOTION_OAUTH_CLIENT_ID: '',
    OAT_AGENTS_TOKEN: token,
    OAT_AGENTS_TOKEN_PREVIOUS: previousToken,
    OAT_AGENTS_RUN_LOG_PREFIX: runLogPrefix,
    OAT_AGENTS_BUSY_RETRY_MS: '1000',
    // Test knobs for D-26 (production uses the web app's 2 min / 3 min); deadline = stale + 60 s.
    OAT_AGENTS_ENHANCE_STALE_MS: String(STALE_MS),
    OAT_AGENTS_ENHANCE_TIMEOUT_MS: '20000',
  };
  port = await freePort();
  server = await startAgent(serverEnv, port);
}, 180_000);

afterAll(async () => {
  await server?.stop();
  proxy?.closeAllConnections();
  await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve(undefined)));
  const redis = createClient({ url: serverEnv?.REDIS_URL });
  await redis
    .connect()
    .then(async () => {
      for await (const keys of redis.scanIterator({ MATCH: `${runLogPrefix}:*` })) {
        if (keys.length) await redis.del(keys);
      }
    })
    .catch(() => undefined)
    .finally(() => redis.destroy());
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

/** A team workspace, its owner, a meeting note with notes + transcript, and a Notion connection. */
async function seedMeeting(options: { autoPush?: boolean } = {}) {
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
    visibility: 'private',
    contentJson: NOTES,
  });
  const meetingId = newId();
  await db.insert(meeting).values({
    id: meetingId,
    documentId,
    startedAt: new Date('2026-11-16T10:00:00Z'),
    endedAt: new Date('2026-11-16T10:30:00Z'),
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
    const auth = createAuth({ db, config: authConfigFromEnv(serverEnv) });
    await db.insert(integration).values({
      workspaceId,
      userId: ownerId,
      provider: 'notion',
      secretEncrypted: await encryptSecret(auth, `ntn_mock_${randomUUID()}`),
      settingsJson: {
        notionWorkspaceId: NOTION_MOCK_IDS.workspace,
        targetType: 'page',
        targetId: NOTION_MOCK_IDS.meetingNotes,
        targetTitle: 'Meeting notes',
        autoPush: options.autoPush,
      },
    });
  }
  return { ownerId, workspaceId, documentId, meetingId };
}

// ---------------------------------------------------------------------------------------------------------
// Jobs API

const auth = { authorization: `Bearer ${token}` };

/** The ids the web app sends (D-29: the meeting and the workspace it authorised the user against). */
const ids = (m: { meetingId: string; workspaceId: string }) => ({
  meetingId: m.meetingId,
  workspaceId: m.workspaceId,
});

function post(body: unknown, bearer = token) {
  return fetch(`${server.url}/jobs/post-meeting`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startRun(body: Record<string, unknown>): Promise<string> {
  const res = await post(body);
  expect(res.status, server.output()).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

const enhancementsOf = (documentId: string) =>
  db.select().from(enhancement).where(eq(enhancement.documentId, documentId));
const exportsOf = (documentId: string) =>
  db.select().from(documentExport).where(eq(documentExport.documentId, documentId));
const hasNotesChunks = async (documentId: string) =>
  (await db.select().from(chunk).where(eq(chunk.documentId, documentId))).some(
    (c) => c.source === 'notes',
  ) || undefined;

type RunView = { runId: string; status: string; result: PostMeetingRun | null };

async function waitForRun(runId: string, timeout = 60_000): Promise<RunView> {
  return waitFor(
    async () => {
      const res = await fetch(`${server.url}/jobs/post-meeting/runs/${runId}`, { headers: auth });
      if (!res.ok) return undefined;
      const view = (await res.json()) as RunView;
      return ['completed', 'failed', 'cancelled'].includes(view.status) ? view : undefined;
    },
    { timeout, interval: 250 },
  );
}

async function runLog(meetingId: string): Promise<PostMeetingRun[]> {
  const res = await fetch(`${server.url}/jobs/post-meeting/${meetingId}`, { headers: auth });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runs: PostMeetingRun[] }).runs;
}

const outcomes = (run: PostMeetingRun | null) =>
  Object.fromEntries((run?.steps ?? []).map((s) => [s.step, s.reason ?? s.outcome]));

const notionCreates = () =>
  mocks.log
    .list({ provider: 'notion' })
    .filter((r) => r.method === 'POST' && r.path === '/notion/v1/pages');

// ---------------------------------------------------------------------------------------------------------

describe('post-meeting workflow on eve (offline)', () => {
  it('jobs contract (D-29): token, workspace check, body shape', async () => {
    const m = await seedMeeting();
    const other = await seedMeeting();
    // Only the current or the previous service token.
    expect((await post(ids(m), 'x'.repeat(43))).status).toBe(401);
    expect((await fetch(`${server.url}/jobs/post-meeting/x`)).status).toBe(401);
    // The workspace is required, and must be the meeting's (unknown meetings look the same).
    expect((await post({ meetingId: m.meetingId })).status).toBe(400);
    expect((await post({ meetingId: m.meetingId, workspaceId: other.workspaceId })).status).toBe(
      404,
    );
    expect(
      (await post({ meetingId: `missing-${randomUUID()}`, workspaceId: m.workspaceId })).status,
    ).toBe(404);
    // The previous token still works during a rotation.
    const res = await post(ids(m), previousToken);
    expect(res.status).toBe(202);
    const view = await waitForRun(((await res.json()) as { runId: string }).runId);
    expect(view.status).toBe('completed');
    expect(await enhancementsOf(other.documentId)).toEqual([]);
  });

  it('enhances, indexes, pushes to Notion and records the run; a second run changes nothing', async () => {
    const m = await seedMeeting({ autoPush: true });
    const llmBefore = mocks.log.list({ provider: 'llm' }).length;
    const [seeded] = await db.select().from(document).where(eq(document.id, m.documentId));

    const runId = await startRun(ids(m));
    const view = await waitForRun(runId);
    expect(view.status, server.output()).toBe('completed');
    expect(view.result).toMatchObject({ runId, meetingId: m.meetingId, documentId: m.documentId });
    expect(outcomes(view.result)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });

    // (1) the web app's enhance job ran as the owner and applied the enhanced body.
    const runs = await db
      .select()
      .from(enhancement)
      .where(eq(enhancement.documentId, m.documentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed',
      idempotencyKey: `${m.ownerId}:${m.documentId}:post-meeting:${runId}`,
    });
    expect((runs[0]!.outputJson as { applied: boolean }).applied).toBe(true);
    const [doc] = await db.select().from(document).where(eq(document.id, m.documentId));
    expect(doc!.version).toBe(seeded!.version + 1);
    expect(doc!.contentJson).not.toEqual(NOTES);
    // …through the mock LLM, over HTTP.
    expect(mocks.log.list({ provider: 'llm' }).length).toBeGreaterThan(llmBefore);

    // (2) the enhanced notes and the transcript are in the retrieval index.
    const chunks = await db.select().from(chunk).where(eq(chunk.documentId, m.documentId));
    expect(chunks.some((c) => c.source === 'notes')).toBe(true);
    expect(chunks.some((c) => c.source === 'transcript')).toBe(true);
    // …and the note's action items (8.4) are in `action_item`, matching what the enhanced body holds.
    const expected = extractActionItems(doc!.contentJson);
    const items = await db.select().from(actionItem).where(eq(actionItem.documentId, m.documentId));
    expect(items.map((i) => i.text).sort()).toEqual(expected.map((i) => i.text).sort());
    const firstIndex = view.result!.steps.find((s) => s.step === 'index')!;
    expect(expected.length).toBeGreaterThan(0);
    expect(firstIndex.detail).toMatchObject({ actionItemsWritten: expected.length });

    // (3) one Notion page, recorded on document_export.
    const [exp] = await db
      .select()
      .from(documentExport)
      .where(eq(documentExport.documentId, m.documentId));
    expect(exp?.externalId).toBeTruthy();
    expect(exp?.pushedVersion).toBe(doc!.version);

    // (4) the per-meeting run log.
    const log = await runLog(m.meetingId);
    expect(log.map((r) => [r.runId, r.status])).toEqual([[runId, 'completed']]);

    // Again: enhance is skipped, nothing is re-embedded, the same Notion page is updated.
    const creates = notionCreates().length;
    const again = await waitForRun(await startRun(ids(m)));
    expect(again.status).toBe('completed');
    expect(outcomes(again.result)).toEqual({
      enhance: 'already enhanced',
      index: 'ran',
      notion: 'ran',
    });
    const index = again.result!.steps.find((s) => s.step === 'index')!;
    expect(index.detail).toMatchObject({ inserted: 0, deleted: 0, actionItemsWritten: 0 });
    const notion = again.result!.steps.find((s) => s.step === 'notion')!;
    expect(notion.detail).toMatchObject({ created: false });
    expect(notionCreates().length).toBe(creates);
    expect((await runLog(m.meetingId)).map((r) => r.runId)).toEqual([again.runId, runId]);
  });

  it('skips the Notion push when auto-push is off or Notion is not connected', async () => {
    const off = await seedMeeting({ autoPush: false });
    const none = await seedMeeting();
    const [a, b] = await Promise.all([
      waitForRun(await startRun(ids(off))),
      waitForRun(await startRun(ids(none))),
    ]);
    expect(outcomes(a.result)).toEqual({ enhance: 'ran', index: 'ran', notion: 'auto-push off' });
    expect(outcomes(b.result)).toEqual({ enhance: 'ran', index: 'ran', notion: 'not connected' });
  });

  it('survives a SIGKILL mid-generation and mid-wait; a run busy past its deadline fails clearly', async () => {
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
    const leasedRun = await startRun(ids(leased));

    // (b) In the durable wait between indexing and the push when the server dies.
    const waiting = await seedMeeting({ autoPush: true });
    const waitingRun = await startRun({ ...ids(waiting), pushDelayMs: 8_000 });
    await waitFor(() => hasNotesChunks(waiting.documentId), { timeout: 30_000, interval: 100 });
    await new Promise((r) => setTimeout(r, 1_000)); // the index step's result is recorded; now sleeping

    // (a) In the middle of its enhance generation when the server dies (the mock LLM hangs).
    const generating = await seedMeeting({ autoPush: true });
    slow.on = true;
    const seen = slow.seen;
    const generatingRun = await startRun(ids(generating));
    const [orphan] = await waitFor(
      async () => {
        const rows = await enhancementsOf(generating.documentId);
        return slow.seen > seen && rows[0]?.status === 'generating' ? rows : undefined;
      },
      { timeout: 30_000, interval: 100 },
    );
    await new Promise((r) => setTimeout(r, 500));

    await server.kill();
    slow.on = false;
    // Really gone (the new server below must not be confused with a survivor on the same port).
    await expect(fetch(`${server.url}/eve/v1/health`)).rejects.toThrow();
    expect(await exportsOf(waiting.documentId)).toEqual([]); // killed before the push
    expect((await enhancementsOf(generating.documentId)).map((r) => r.status)).toEqual([
      'generating',
    ]);

    server = await startAgent(serverEnv, port);

    // (a) The orphaned generation stays `generating` until D-26 staleness: the step answers busy, the workflow
    // sleeps and asks again; once stale it is settled as failed and a fresh run is applied.
    const a = await waitForRun(generatingRun, 180_000).catch(async (error: unknown) => {
      // Diagnostics for a timeout: the note's enhancement runs and the server's recent output.
      const rows = await enhancementsOf(generating.documentId);
      console.error(
        '[8.2 crash case] enhancements:',
        JSON.stringify(rows.map((r) => [r.status, r.idempotencyKey, r.startedAt, r.outputJson])),
        '\nserver output (tail):\n',
        server.output().slice(-6000),
      );
      throw error;
    });
    expect(a.status, server.output()).toBe('completed');
    expect(outcomes(a.result)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    const enhance = a.result!.steps.find((s) => s.step === 'enhance')!;
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
    const b = await waitForRun(waitingRun, 60_000);
    expect(b.status).toBe('completed');
    expect(outcomes(b.result)).toEqual({ enhance: 'ran', index: 'ran', notion: 'ran' });
    expect(await enhancementsOf(waiting.documentId)).toHaveLength(1);
    expect((await exportsOf(waiting.documentId))[0]?.externalId).toBeTruthy();

    // (c) Busy past the deadline (stale + 60 s): failed with the reason, and logged.
    const c = await waitForRun(leasedRun, 120_000);
    expect(c.status).toBe('failed');
    const [entry] = await runLog(leased.meetingId);
    expect(entry).toMatchObject({ status: 'failed', documentId: leased.documentId });
    expect(entry!.steps.map((s) => s.step)).toEqual(['enhance', 'index']);
    expect(entry!.error).toMatch(/gave up after waiting \d+ s: notion: notion_busy/);
  }, 360_000);
});
