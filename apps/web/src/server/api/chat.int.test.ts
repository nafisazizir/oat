/**
 * The assistant API (6.2/6.3) end to end through the route handlers: real Better Auth sessions, documents
 * written through the documents API, chunks indexed with `@oat/indexing` (mock embeddings), and the mock LLM's
 * scripted tool loop running in-process. Deny cases: anonymous, non-members, other members' private notes (via
 * scope, via search inside the chat), other users' threads and proposals, viewers proposing edits, a note that
 * became private, stale approvals.
 */
import { createMockChatModel } from '@oat/ai/chat/testing';
import { createMemoryRateLimiter, type RateLimiter } from '@oat/auth';
import { createMockEmbeddingModel, createMockModel } from '@oat/ai/testing';
import { chatMessage, meeting, membership, newId, transcriptSegment } from '@oat/db';
import { indexDocument } from '@oat/indexing/indexer';
import { searchChunks } from '@oat/indexing/retrieval';
import { waitFor } from '@oat/testkit';
import type { LanguageModel } from 'ai';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DocumentDetail } from '@/lib/api-types';
import type { ChatThreadDetail, ChatThreadSummary, ProposalDecisionResult } from '@/lib/chat-types';

import { type ChatDeps, createChatApi } from '../chat';
import { BASE, call, createHarness, denies, type Harness, type TestUser } from './test-harness';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let vic: TestUser;
let outsider: TestUser;
let team: string;
let standup: DocumentDetail;
let secret: DocumentDetail;
const segIds = { standup: [] as string[], secret: [] as string[] };

const embeddingModel = createMockEmbeddingModel();
let model: () => LanguageModel = () => createMockChatModel();
const memoryLimiter = createMemoryRateLimiter();
/** Rate-limit keys seen, and users whose next requests are over the limit. */
const limiterKeys: string[] = [];
const overLimit = new Set<string>();
const limiter: RateLimiter = {
  async hit(key, max, windowSec) {
    limiterKeys.push(key);
    if ([...overLimit].some((id) => key.endsWith(`:${id}`))) {
      return { allowed: false, count: max + 1, retryAfter: 42 };
    }
    return memoryLimiter.hit(key, max, windowSec);
  },
  close: () => memoryLimiter.close(),
};
const chatDeps: ChatDeps = {
  model: () => model(),
  search: (db) => (permissions, query, request) =>
    searchChunks({ db, permissions, embeddingModel }, query, request),
  rateLimiter: () => limiter,
};
let api: ReturnType<typeof createChatApi>;

const p = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

async function created(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

async function addTranscript(documentId: string, lines: [string, string][]): Promise<string[]> {
  const meetingId = newId();
  await h.db
    .insert(meeting)
    .values({ id: meetingId, documentId, startedAt: new Date('2026-11-10T16:00:00Z') });
  const ids: string[] = [];
  for (const [i, [speaker, text]] of lines.entries()) {
    const id = newId();
    ids.push(id);
    await h.db.insert(transcriptSegment).values({
      id,
      meetingId,
      source: speaker === 'me' ? 'mic' : 'system',
      speakerLabel: speaker === 'me' ? null : speaker,
      startMs: 1_000 + i * 6_000,
      endMs: 6_000 + i * 6_000,
      text,
    });
  }
  return ids;
}

type Chunk = { type: string; [key: string]: unknown };

/** POSTs to /api/chat and reads the whole UI message stream. */
async function ask(
  as: TestUser | null,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  chunks: Chunk[];
  text: string;
  threadId: string | null;
  error?: string;
  retryAfter?: number;
}> {
  const headers = new Headers({ origin: BASE, 'content-type': 'application/json' });
  if (as) headers.set('cookie', as.cookie);
  const res = await api.chat.POST(
    new Request(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({}) },
  );
  const raw = await res.text();
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    return {
      status: res.status,
      chunks: [],
      text: '',
      threadId: null,
      error: JSON.parse(raw).error?.code,
      retryAfter: JSON.parse(raw).retryAfter,
    };
  }
  const chunks = raw
    .split('\n\n')
    .map((frame) => frame.replace(/^data: /, '').trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data) as Chunk);
  const text = chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.delta as string)
    .join('');
  return { status: res.status, chunks, text, threadId: res.headers.get('x-oat-thread-id') };
}

const message = (text: string) => [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }];
const workspaceScope = () => ({ kind: 'workspace', workspaceId: team });

const citations = (text: string) =>
  [...text.matchAll(/\[\[(seg|block):([^\]]+)\]\]/g)].map((m) => m[2]!);

async function thread(as: TestUser, id: string) {
  return call<ChatThreadDetail>(api.thread.GET, 'GET', `/api/chat/threads/${id}`, {
    as,
    params: { id },
  });
}

/** The answer is saved when the stream ends; wait for it. */
async function savedThread(as: TestUser, id: string, messages: number) {
  return waitFor(
    async () => {
      const res = await thread(as, id);
      return res.status === 200 && res.body.messages.length >= messages ? res.body : undefined;
    },
    { timeout: 5_000, interval: 50 },
  );
}

const decide = (as: TestUser, threadId: string, proposalId: string, decision: string) =>
  call<ProposalDecisionResult>(
    api.proposal.POST,
    'POST',
    `/api/chat/threads/${threadId}/proposals/${proposalId}`,
    { as, body: { decision }, params: { id: threadId, proposalId } },
  );

beforeAll(async () => {
  h = await createHarness();
  api = createChatApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    chatDeps,
  );
  [alice, bob, vic, outsider] = await Promise.all([
    h.signUp('alice'),
    h.signUp('bob'),
    h.signUp('vic'),
    h.signUp('outsider'),
  ]);
  team = await h.teamWorkspace(alice, [
    [bob, 'member'],
    [vic, 'viewer'],
  ]);
  standup = await created(alice, {
    workspaceId: team,
    kind: 'meeting',
    title: 'Pricing sync',
    visibility: 'workspace',
    contentJson: {
      type: 'doc',
      content: [
        p('b-price', 'We keep the starter plan at twelve dollars per seat.'),
        p('b-launch', 'Launch moves to the first week of May.'),
      ],
    },
  });
  secret = await created(alice, {
    workspaceId: team,
    kind: 'meeting',
    title: 'Salary review',
    contentJson: { type: 'doc', content: [p('b-salary', 'Salary bands rise by eight percent.')] },
  });
  segIds.standup = await addTranscript(standup.id, [
    ['me', 'Should we raise the starter plan price?'],
    ['Dana', 'Keep the starter plan at twelve dollars per seat, customers are price sensitive.'],
    ['Dana', 'And the launch moves to the first week of May.'],
  ]);
  segIds.secret = await addTranscript(secret.id, [
    ['Dana', 'Salary bands rise by eight percent next year.'],
  ]);
  for (const doc of [standup, secret]) await indexDocument({ db: h.db, embeddingModel }, doc.id);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('POST /api/chat', () => {
  it('401 without a session', async () => {
    const res = await ask(null, { scope: workspaceScope(), messages: message('hi') });
    expect(res.status).toBe(401);
  });

  it('workspace chat: searches, streams an answer with valid citations, persists the thread', async () => {
    const res = await ask(bob, {
      scope: workspaceScope(),
      messages: message('What price per seat did Dana want for the starter plan?'),
    });
    expect(res.status).toBe(200);
    expect(res.threadId).toBeTruthy();
    const start = res.chunks.find((c) => c.type === 'start')!;
    expect(start.messageMetadata).toMatchObject({
      threadId: res.threadId,
      userMessageId: expect.any(String),
    });
    expect(
      res.chunks.some((c) => c.type === 'tool-input-available' && c.toolName === 'searchMeetings'),
    ).toBe(true);
    const cited = citations(res.text);
    expect(cited.length).toBeGreaterThan(0);
    const allowed = new Set([...segIds.standup, 'b-price', 'b-launch']);
    for (const id of cited) expect(allowed.has(id), id).toBe(true);
    expect(res.text).toMatch(/twelve dollars/);
    expect(res.text).not.toMatch(/Salary|eight percent/);

    const saved = await savedThread(bob, res.threadId!, 2);
    expect(saved.thread).toMatchObject({ scope: 'workspace', workspaceId: team, documentId: null });
    expect(saved.thread.title).toBe('What price per seat did Dana want for the starter plan?');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const answer = saved.messages[1]!;
    expect(answer.parts.some((part) => part.type === 'tool-searchMeetings')).toBe(true);
    expect(answer.metadata?.citations?.map((c) => c.id)).toEqual([...new Set(cited)]);

    // A follow-up continues the same thread with its history.
    const again = await ask(bob, {
      threadId: res.threadId,
      scope: workspaceScope(),
      messages: message('And when is the launch?'),
    });
    expect(again.status).toBe(200);
    expect(again.threadId).toBe(res.threadId);
    expect((await savedThread(bob, res.threadId!, 4)).messages).toHaveLength(4);
  });

  it('deny: search inside the chat never surfaces another member’s private note', async () => {
    const res = await ask(bob, {
      scope: workspaceScope(),
      messages: message('Salary bands rise by eight percent?'),
    });
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/eight percent/);
    for (const id of citations(res.text)) {
      expect([...segIds.secret, 'b-salary']).not.toContain(id);
    }
    const outputs = JSON.stringify(res.chunks.filter((c) => c.type === 'tool-output-available'));
    expect(outputs).not.toContain(secret.id);
    // The owner does find it.
    const own = await ask(alice, {
      scope: workspaceScope(),
      messages: message('Salary bands rise by eight percent?'),
    });
    expect(own.text).toMatch(/eight percent/);
  });

  it('deny: private note scope, non-member workspace, someone else’s thread, wrong scope, bad input', async () => {
    denies('POST /api/chat');
    const privateNote = await ask(bob, {
      scope: { kind: 'document', documentId: secret.id },
      messages: message('What is in here?'),
    });
    expect(privateNote).toMatchObject({ status: 404, error: 'not_found' });
    const stranger = await ask(outsider, {
      scope: workspaceScope(),
      messages: message('pricing?'),
    });
    expect(stranger).toMatchObject({ status: 404, error: 'not_found' });

    const mine = await ask(alice, { scope: workspaceScope(), messages: message('pricing?') });
    const hijack = await ask(bob, {
      threadId: mine.threadId,
      scope: workspaceScope(),
      messages: message('hi'),
    });
    expect(hijack).toMatchObject({ status: 404, error: 'not_found' });
    const otherScope = await ask(alice, {
      threadId: mine.threadId,
      scope: { kind: 'document', documentId: standup.id },
      messages: message('hi'),
    });
    expect(otherScope).toMatchObject({ status: 400, error: 'bad_request' });

    for (const messages of [
      [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
      message('   '),
      message('x'.repeat(9_000)),
    ]) {
      expect(await ask(alice, { scope: workspaceScope(), messages })).toMatchObject({
        status: 400,
      });
    }
  });

  it('document chat: answers from the note with citations from its context or tools', async () => {
    const res = await ask(alice, {
      scope: { kind: 'document', documentId: standup.id },
      messages: message('What did Dana say about the price?'),
    });
    expect(res.status).toBe(200);
    const cited = citations(res.text);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect([...segIds.standup, 'b-price', 'b-launch']).toContain(id);
    const saved = await savedThread(alice, res.threadId!, 2);
    expect(saved.thread).toMatchObject({ scope: 'document', documentId: standup.id });
  });

  it('strips citations the model invents before streaming and saving', async () => {
    model = () =>
      createMockModel({
        responses: [`Twelve dollars [[seg:${segIds.secret[0]}]][[block:made-up]] per seat.`],
      });
    try {
      const res = await ask(bob, { scope: workspaceScope(), messages: message('price?') });
      expect(res.text).toBe('Twelve dollars  per seat.');
      const saved = await savedThread(bob, res.threadId!, 2);
      expect(JSON.stringify(saved.messages[1]!.parts)).not.toContain('[[');
      const [row] = await h.db
        .select()
        .from(chatMessage)
        .where(eq(chatMessage.id, saved.messages[1]!.id));
      expect(row!.contextJson).toMatchObject({
        citations: [],
        dropped: [`[[seg:${segIds.secret[0]}]]`, '[[block:made-up]]'],
      });
    } finally {
      model = () => createMockChatModel();
    }
  });
});

describe('limits and recovery', () => {
  it('rate limits per user: 429 rate_limited with retryAfter, others unaffected', async () => {
    const spammer = await h.signUp('spammer');
    await h.db.insert(membership).values({ workspaceId: team, userId: spammer.id, role: 'member' });
    limiterKeys.length = 0;
    expect((await ask(spammer, { scope: workspaceScope(), messages: message('hi') })).status).toBe(
      200,
    );
    expect(limiterKeys).toEqual([`chat:minute:${spammer.id}`, `chat:day:${spammer.id}`]);
    overLimit.add(spammer.id);
    try {
      const limited = await ask(spammer, { scope: workspaceScope(), messages: message('hi') });
      expect(limited).toMatchObject({ status: 429, error: 'rate_limited', retryAfter: 42 });
      expect((await ask(bob, { scope: workspaceScope(), messages: message('hi') })).status).toBe(
        200,
      );
    } finally {
      overLimit.delete(spammer.id);
    }
  });

  it('a thread whose last answer was aborted mid tool call still works', async () => {
    const first = await ask(bob, { scope: workspaceScope(), messages: message('price?') });
    await savedThread(bob, first.threadId!, 2);
    // What an abort during a tool call used to leave behind: a call without a result.
    await h.db.insert(chatMessage).values({
      threadId: first.threadId!,
      role: 'assistant',
      partsJson: [
        { type: 'step-start' },
        {
          type: 'tool-searchMeetings',
          toolCallId: 'call-aborted',
          state: 'input-available',
          input: { query: 'price' },
        },
      ],
      contextJson: { aborted: true },
      createdAt: new Date(),
    });
    const next = await ask(bob, {
      threadId: first.threadId,
      scope: workspaceScope(),
      messages: message('What price per seat did Dana want for the starter plan?'),
    });
    expect(next.status).toBe(200);
    expect(next.text).toMatch(/twelve dollars/);
    const saved = await savedThread(bob, first.threadId!, 5);
    // Newly saved answers never contain unfinished tool calls.
    for (const m of saved.messages.slice(3)) {
      for (const part of m.parts) {
        if (part.type.startsWith('tool-'))
          expect((part as { state: string }).state).toMatch(/^output-/);
      }
    }
  });
});

describe('GET /api/chat/threads', () => {
  it('lists only the actor’s own threads in a workspace they belong to', async () => {
    denies('GET /api/chat/threads', 'GET /api/chat/threads/[id]');
    const bobs = await call<{ threads: ChatThreadSummary[] }>(
      api.threads.GET,
      'GET',
      `/api/chat/threads?workspaceId=${team}`,
      { as: bob },
    );
    expect(bobs.status).toBe(200);
    expect(bobs.body.threads.length).toBeGreaterThan(0);
    const alices = await call<{ threads: ChatThreadSummary[] }>(
      api.threads.GET,
      'GET',
      `/api/chat/threads?workspaceId=${team}`,
      { as: alice },
    );
    const bobIds = new Set(bobs.body.threads.map((t) => t.id));
    expect(alices.body.threads.some((t) => bobIds.has(t.id))).toBe(false);
    const forDoc = await call<{ threads: ChatThreadSummary[] }>(
      api.threads.GET,
      'GET',
      `/api/chat/threads?workspaceId=${team}&documentId=${standup.id}`,
      { as: alice },
    );
    expect(forDoc.body.threads.every((t) => t.documentId === standup.id)).toBe(true);
    expect(forDoc.body.threads.length).toBeGreaterThan(0);

    expect(
      (
        await call(api.threads.GET, 'GET', `/api/chat/threads?workspaceId=${team}`, {
          as: outsider,
        })
      ).status,
    ).toBe(404);
    expect((await call(api.threads.GET, 'GET', '/api/chat/threads', { as: bob })).status).toBe(400);
    expect(
      (
        await call(
          api.threads.GET,
          'GET',
          `/api/chat/threads?workspaceId=${team}&documentId=${secret.id}`,
          {
            as: bob,
          },
        )
      ).status,
    ).toBe(404);
    // Someone else's thread: 404, never its contents.
    expect((await thread(alice, [...bobIds][0]!)).status).toBe(404);
    expect((await thread(outsider, [...bobIds][0]!)).status).toBe(404);
  });

  it('a note chat disappears when the note stops being readable', async () => {
    const page = await created(alice, {
      workspaceId: team,
      title: 'Shared plan',
      visibility: 'workspace',
      contentJson: { type: 'doc', content: [p('b-plan', 'The plan is to ship on Friday.')] },
    });
    const res = await ask(bob, {
      scope: { kind: 'document', documentId: page.id },
      messages: message('plan?'),
    });
    await savedThread(bob, res.threadId!, 2);
    const share = await call(
      h.api.documentShare.PATCH,
      'PATCH',
      `/api/documents/${page.id}/share`,
      {
        as: alice,
        body: { visibility: 'private' },
        params: { id: page.id },
      },
    );
    expect(share.status).toBe(200);
    expect((await thread(bob, res.threadId!)).status).toBe(404);
  });
});

describe('updateDocument proposals', () => {
  async function propose(as: TestUser, find: string, replace: string) {
    const directive = `mock:tool updateDocument ${JSON.stringify({ documentId: standup.id, edits: [{ find, replace }] })}`;
    const res = await ask(as, { scope: workspaceScope(), messages: message(directive) });
    expect(res.status).toBe(200);
    const saved = await savedThread(as, res.threadId!, 2);
    return { threadId: res.threadId!, proposals: saved.messages[1]!.metadata?.proposals ?? [] };
  }

  const current = async () =>
    (
      await call<DocumentDetail>(h.api.document.GET, 'GET', `/api/documents/${standup.id}`, {
        as: alice,
        params: { id: standup.id },
      })
    ).body;

  it('the tool only proposes; approval applies it at the base version, once', async () => {
    const before = await current();
    const { threadId, proposals } = await propose(bob, 'first week of May', 'second week of May');
    expect(proposals).toEqual([
      expect.objectContaining({
        status: 'pending',
        documentId: standup.id,
        baseVersion: before.version,
        changes: [expect.objectContaining({ blockId: 'b-launch' })],
      }),
    ]);
    // Nothing written yet.
    expect((await current()).version).toBe(before.version);

    denies('POST /api/chat/threads/[id]/proposals/[proposalId]');
    expect((await decide(alice, threadId, proposals[0]!.id, 'approve')).status).toBe(404);
    expect((await decide(outsider, threadId, proposals[0]!.id, 'approve')).status).toBe(404);
    expect((await decide(bob, threadId, 'nope', 'approve')).status).toBe(404);
    expect((await decide(bob, threadId, proposals[0]!.id, 'maybe')).status).toBe(400);

    const ok = await decide(bob, threadId, proposals[0]!.id, 'approve');
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.body.proposal).toMatchObject({
      status: 'applied',
      appliedVersion: before.version + 1,
    });
    const after = await current();
    expect(after.version).toBe(before.version + 1);
    expect(JSON.stringify(after.contentJson)).toContain('second week of May');
    // Block ids survive the edit.
    expect(JSON.stringify(after.contentJson)).toContain('"id":"b-launch"');

    const twice = await decide(bob, threadId, proposals[0]!.id, 'approve');
    expect(twice).toMatchObject({ status: 409, error: { code: 'proposal_closed' } });
  });

  it('a stale base version is a 409 with the server copy; rejecting closes a proposal', async () => {
    const { threadId, proposals } = await propose(bob, 'twelve dollars', 'fourteen dollars');
    const doc = await current();
    const edit = await call(h.api.document.PATCH, 'PATCH', `/api/documents/${standup.id}`, {
      as: alice,
      body: { baseVersion: doc.version, title: 'Pricing sync (edited)' },
      params: { id: standup.id },
    });
    expect(edit.status).toBe(200);
    const stale = await decide(bob, threadId, proposals[0]!.id, 'approve');
    expect(stale.status).toBe(409);
    expect(stale.error?.code).toBe('stale_version');
    expect((stale.body as { document?: DocumentDetail }).document?.version).toBe(doc.version + 1);
    const saved = await thread(bob, threadId);
    expect(saved.body.messages[1]!.metadata?.proposals?.[0]?.status).toBe('stale');
    expect(JSON.stringify((await current()).contentJson)).toContain('twelve dollars');

    const next = await propose(bob, 'twelve dollars', 'ten dollars');
    const rejected = await decide(bob, next.threadId, next.proposals[0]!.id, 'reject');
    expect(rejected.body.proposal.status).toBe('rejected');
    expect((await decide(bob, next.threadId, next.proposals[0]!.id, 'approve')).status).toBe(409);
  });

  it('deny: a viewer gets no proposal', async () => {
    const { proposals } = await propose(vic, 'twelve dollars', 'free');
    expect(proposals).toEqual([]);
  });
});
