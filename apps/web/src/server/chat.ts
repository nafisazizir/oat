import 'server-only';

import {
  CHAT_LIMITS,
  completeParts,
  CitationRegistry,
  loadDocumentContext,
  registerHistory,
  streamAssistant,
  trimHistory,
} from '@oat/ai/chat';
import { getModel } from '@oat/ai/provider';
import {
  applyTextEdits,
  createDbAssistantData,
  type EditProposal,
  type SearchFn,
  type ToolScope,
} from '@oat/ai/tools';
import type { RateLimiter } from '@oat/auth';
import { canReadDocument, roleIn } from '@oat/core';
import {
  chatMessage,
  chatThread,
  type Db,
  document,
  meeting,
  newId,
  transcriptSegment,
} from '@oat/db';
import { searchChunks } from '@oat/indexing/retrieval';
import { consumeStream, type LanguageModel, type UIMessage } from 'ai';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { DocumentDetail } from '@/lib/api-types';
import type {
  ChatMessageMetadata,
  ChatProposal,
  ChatSources,
  ChatThreadDetail,
  ChatThreadSummary,
  ProposalDecisionResult,
} from '@/lib/chat-types';

import type { Actor } from './actor';
import { ApiError, badRequest, notFound, staleVersion } from './api/errors';
import { type ApiDeps, apiRoute, readJson } from './api/route';
import { getDocument, updateDocument } from './documents';
import { aiProfile } from './profile';

/*
 * The assistant API (tasks 6.2/6.3, SPEC §4 Assistant, §7 grounding, D-7). Threads are private to the user
 * who started them. Every request re-derives what the actor may see: the thread must be theirs, they must
 * still be a member of its workspace, and a note chat's document must still be readable. The model only
 * reaches data through `@oat/ai/tools`, which re-check `@oat/core` permissions on every row.
 *
 *   POST /api/chat                           { threadId?, scope, messages } → AI SDK UI message stream.
 *        Only the last message (the new user turn) is taken from the client; history comes from the thread.
 *        Response header `x-oat-thread-id`; the `start` part's metadata carries `{ threadId, userMessageId }`.
 *   GET  /api/chat/threads?workspaceId=…[&documentId=…]       ChatThreadSummary[] (newest first)
 *   GET  /api/chat/threads/:id                                 ChatThreadDetail (+ `sources`: what its
 *        citations and proposals point at, re-resolved against the reader's current access, 6.4)
 *   POST /api/chat/threads/:id/proposals/:proposalId           { decision: approve|reject }
 *        approve → re-applies the edits to the document at the proposal's `baseVersion` through the documents
 *        API (`updateDocument`): 409 `stale_version` (+ server copy) when the document moved on,
 *        409 `proposal_closed` when already decided.
 *
 * `POST /api/chat` is the most expensive route (up to `CHAT_LIMITS.maxSteps` model calls with history,
 * note context and tool output), so it is rate limited per user (`CHAT_RATE_LIMITS`, Redis-backed in
 * production): 429 `rate_limited` with `retryAfter` (seconds).
 */

export const CHAT_RATE_LIMITS = {
  minute: { max: 20, windowSec: 60 },
  day: { max: 500, windowSec: 24 * 60 * 60 },
} as const;

/** What the chat needs besides the API deps (injected so int tests use the mock LLM and embeddings). */
export type ChatDeps = {
  model(): LanguageModel;
  /** Retrieval over `db` (permission-safe). */
  search(db: Db): SearchFn;
  /** Per-user limits (`apiRateLimiter()` in production). */
  rateLimiter(): RateLimiter;
};

/** Production: the `chat` role model and `searchChunks` with the default embedding model. */
export const defaultChatDeps: Omit<ChatDeps, 'rateLimiter'> = {
  model: () => getModel('chat'),
  search: (db) => (permissions, query, request) =>
    searchChunks({ db, permissions }, query, request),
};

async function limitChat(limiter: RateLimiter, userId: string): Promise<void> {
  for (const [name, rule] of Object.entries(CHAT_RATE_LIMITS)) {
    const hit = await limiter.hit(`chat:${name}:${userId}`, rule.max, rule.windowSec);
    if (!hit.allowed) {
      throw new ApiError(
        429,
        'rate_limited',
        'You’ve sent a lot of questions. Wait a moment and try again.',
        { retryAfter: hit.retryAfter },
      );
    }
  }
}

const Id = z.string().min(1).max(100);
const MAX_TITLE = 80;

const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: Id }),
  z.object({ kind: z.literal('workspace'), workspaceId: Id }),
]);

const IncomingMessage = z.object({
  id: z.string().max(200).optional(),
  role: z.string().max(20),
  parts: z.array(z.looseObject({ type: z.string().max(100) })).max(100),
});

const ChatRequest = z.object({
  threadId: Id.optional(),
  scope: Scope,
  messages: z.array(IncomingMessage).min(1).max(500),
  /** IANA zone for "today" and meeting dates. */
  timeZone: z.string().max(64).optional(),
});

const Decision = z.strictObject({ decision: z.enum(['approve', 'reject']) });

type ThreadRow = typeof chatThread.$inferSelect;

type StoredContext = {
  scope?: ToolScope;
  citations?: { kind: 'seg' | 'block'; id: string }[];
  dropped?: string[];
  proposals?: (EditProposal & { appliedVersion?: number })[];
  toolCalls?: string[];
  finishReason?: string;
  aborted?: boolean;
  model?: string;
};

const proposalClosed = (status: string) =>
  new ApiError(409, 'proposal_closed', `This change was already ${status}.`);

// ---------------------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------------------

/** A live document the actor can read, else 404 (trash included: you can't chat about a trashed note). */
async function readableDocument(db: Db, actor: Actor, id: string) {
  const [row] = await db.select().from(document).where(eq(document.id, id));
  if (!row || row.deletedAt !== null || !canReadDocument(actor.ctx, row)) throw notFound();
  return row;
}

/** Whether the actor may (still) use this thread of theirs. */
async function threadVisible(db: Db, actor: Actor, thread: ThreadRow): Promise<boolean> {
  if (thread.userId !== actor.userId || roleIn(actor.ctx, thread.workspaceId) === undefined)
    return false;
  if (thread.scope !== 'document') return true;
  const [row] = await db.select().from(document).where(eq(document.id, thread.documentId!));
  return !!row && row.deletedAt === null && canReadDocument(actor.ctx, row);
}

async function ownThread(db: Db, actor: Actor, id: string): Promise<ThreadRow> {
  const [thread] = await db
    .select()
    .from(chatThread)
    .where(and(eq(chatThread.id, id), eq(chatThread.userId, actor.userId)));
  if (!thread || !(await threadVisible(db, actor, thread))) throw notFound('Thread');
  return thread;
}

const summary = (t: ThreadRow): ChatThreadSummary => ({
  id: t.id,
  workspaceId: t.workspaceId,
  scope: t.scope,
  documentId: t.documentId,
  title: t.title,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

function publicProposal(p: NonNullable<StoredContext['proposals']>[number]): ChatProposal {
  return {
    id: p.id,
    documentId: p.documentId,
    baseVersion: p.baseVersion,
    summary: p.summary,
    changes: p.changes,
    status: p.status,
    ...(p.appliedVersion !== undefined ? { appliedVersion: p.appliedVersion } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------------------

export async function listThreads(
  db: Db,
  actor: Actor,
  input: { workspaceId: string; documentId?: string },
): Promise<{ threads: ChatThreadSummary[] }> {
  if (roleIn(actor.ctx, input.workspaceId) === undefined) throw notFound('Workspace');
  if (input.documentId) await readableDocument(db, actor, input.documentId);
  const rows = await db
    .select()
    .from(chatThread)
    .where(
      and(
        eq(chatThread.userId, actor.userId),
        eq(chatThread.workspaceId, input.workspaceId),
        input.documentId ? eq(chatThread.documentId, input.documentId) : undefined,
      ),
    )
    .orderBy(desc(chatThread.updatedAt), desc(chatThread.id))
    .limit(100);
  const visible: ChatThreadSummary[] = [];
  for (const row of rows) if (await threadVisible(db, actor, row)) visible.push(summary(row));
  return { threads: visible };
}

async function threadMessages(db: Db, threadId: string) {
  return db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.threadId, threadId))
    .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id));
}

function toUiMessage(
  row: typeof chatMessage.$inferSelect,
  threadId: string,
): UIMessage<ChatMessageMetadata> {
  const context = (row.contextJson ?? {}) as StoredContext;
  const metadata: ChatMessageMetadata = { threadId };
  if (row.role === 'assistant') {
    metadata.citations = context.citations ?? [];
    metadata.proposals = (context.proposals ?? []).map(publicProposal);
  }
  return {
    id: row.id,
    role: row.role,
    parts: row.partsJson as UIMessage['parts'],
    metadata,
  };
}

export async function getThread(db: Db, actor: Actor, id: string): Promise<ChatThreadDetail> {
  const thread = await ownThread(db, actor, id);
  const rows = await threadMessages(db, thread.id);
  return {
    thread: summary(thread),
    messages: rows.map((row) => ({
      ...toUiMessage(row, thread.id),
      createdAt: row.createdAt.toISOString(),
    })),
    sources: await resolveSources(db, actor, thread, rows),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Sources (6.4): what citation chips and proposal cards show
// ---------------------------------------------------------------------------------------------------------

const SOURCE_TEXT_CHARS = 280;
const MAX_SOURCE_IDS = 500;
const MAX_CANDIDATE_DOCUMENTS = 50;

const capText = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SOURCE_TEXT_CHARS ? `${line.slice(0, SOURCE_TEXT_CHARS - 1)}…` : line;
};

/** `documentId` strings anywhere in stored parts (tool inputs and outputs): where cited blocks can live. */
function documentIdsIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12 || out.size >= MAX_CANDIDATE_DOCUMENTS) return;
  if (Array.isArray(value)) {
    for (const v of value) documentIdsIn(v, out, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'documentId' && typeof v === 'string' && v.length <= 100) out.add(v);
      else documentIdsIn(v, out, depth + 1);
    }
  }
}

/** Plain text of every block with an id (TipTap JSON), by id. */
function blockTexts(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const textOf = (node: unknown): string => {
    if (node === null || typeof node !== 'object') return '';
    const n = node as {
      type?: unknown;
      text?: unknown;
      attrs?: { label?: unknown };
      content?: unknown[];
    };
    if (n.type === 'text' && typeof n.text === 'string') return n.text;
    if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
    return (n.content ?? [])
      .map(textOf)
      .join(n.type === 'paragraph' || n.type === 'heading' ? '' : ' ');
  };
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { attrs?: { id?: unknown }; content?: unknown[] };
    if (typeof n.attrs?.id === 'string' && !out.has(n.attrs.id))
      out.set(n.attrs.id, capText(textOf(n)));
    n.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

/**
 * Resolves a thread's citations and proposal targets for display. Everything is re-checked against the
 * reader's access *now*: a segment or block in a note they can no longer read (or that was deleted) is simply
 * absent, and the chip shows as unavailable. Blocks are looked up only in documents the thread itself
 * touched (its note, documents named in tool calls/results, proposal targets), never workspace-wide.
 */
async function resolveSources(
  db: Db,
  actor: Actor,
  thread: ThreadRow,
  rows: (typeof chatMessage.$inferSelect)[],
): Promise<ChatSources> {
  const segIds = new Set<string>();
  const blockIds = new Set<string>();
  const proposalDocs = new Set<string>();
  const candidates = new Set<string>(thread.documentId ? [thread.documentId] : []);
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    const context = (row.contextJson ?? {}) as StoredContext;
    for (const c of context.citations ?? []) (c.kind === 'seg' ? segIds : blockIds).add(c.id);
    for (const p of context.proposals ?? []) {
      proposalDocs.add(p.documentId);
      candidates.add(p.documentId);
    }
    documentIdsIn(row.partsJson, candidates);
  }

  const segments =
    segIds.size === 0
      ? []
      : await db
          .select({
            id: transcriptSegment.id,
            startMs: transcriptSegment.startMs,
            source: transcriptSegment.source,
            speakerLabel: transcriptSegment.speakerLabel,
            text: transcriptSegment.text,
            documentId: meeting.documentId,
          })
          .from(transcriptSegment)
          .innerJoin(meeting, eq(meeting.id, transcriptSegment.meetingId))
          .where(inArray(transcriptSegment.id, [...segIds].slice(0, MAX_SOURCE_IDS)));

  const wanted = [
    ...new Set([...segments.map((s) => s.documentId), ...candidates, ...proposalDocs]),
  ];
  // Access fields only: no note bodies are read here (blocks are extracted in SQL below).
  type AccessRow = Pick<
    typeof document.$inferSelect,
    'id' | 'workspaceId' | 'ownerId' | 'visibility' | 'shareToken' | 'deletedAt' | 'title'
  >;
  const readable = new Map<string, AccessRow>();
  if (wanted.length > 0) {
    const rows = await db
      .select({
        id: document.id,
        workspaceId: document.workspaceId,
        ownerId: document.ownerId,
        visibility: document.visibility,
        shareToken: document.shareToken,
        deletedAt: document.deletedAt,
        title: document.title,
      })
      .from(document)
      .where(inArray(document.id, wanted));
    for (const row of rows) {
      if (row.deletedAt === null && canReadDocument(actor.ctx, row)) readable.set(row.id, row);
    }
  }
  const title = (row: AccessRow) => row.title.trim() || 'Untitled';

  const citations: ChatSources['citations'] = {};
  for (const s of segments) {
    const doc = readable.get(s.documentId);
    if (!doc) continue;
    citations[`seg:${s.id}`] = {
      kind: 'seg',
      id: s.id,
      documentId: doc.id,
      title: title(doc),
      startMs: s.startMs,
      speaker: s.source === 'mic' ? 'Me' : s.speakerLabel?.trim() || 'Them',
      text: capText(s.text),
    };
  }
  const blockDocs = [...candidates].filter((id) => readable.has(id));
  if (blockIds.size > 0 && blockDocs.length > 0) {
    // Only the cited blocks come back from Postgres (jsonpath over the body), not whole documents.
    const ids = JSON.stringify([...blockIds].slice(0, MAX_SOURCE_IDS));
    const rows = await db
      .select({
        id: document.id,
        blocks: sql<
          unknown[]
        >`jsonb_path_query_array(${document.contentJson}, 'strict $.** ? (@.attrs.id == $ids[*])', jsonb_build_object('ids', ${ids}::jsonb))`,
      })
      .from(document)
      .where(inArray(document.id, blockDocs));
    // Candidate order decides which document a (duplicated) block id resolves to.
    rows.sort((a, b) => blockDocs.indexOf(a.id) - blockDocs.indexOf(b.id));
    for (const row of rows) {
      const doc = readable.get(row.id)!;
      for (const block of row.blocks ?? []) {
        const blockId = (block as { attrs?: { id?: unknown } }).attrs?.id;
        if (typeof blockId !== 'string' || !blockIds.has(blockId)) continue;
        const key = `block:${blockId}`;
        if (citations[key]) continue;
        citations[key] = {
          kind: 'block',
          id: blockId,
          documentId: doc.id,
          title: title(doc),
          text: blockTexts(block).get(blockId) ?? '',
        };
      }
    }
  }

  const documents: ChatSources['documents'] = {};
  for (const id of proposalDocs) {
    const doc = readable.get(id);
    if (doc) documents[id] = { title: title(doc) };
  }
  return { citations, documents };
}

// ---------------------------------------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------------------------------------

function userText(message: z.infer<typeof IncomingMessage>): string {
  if (message.role !== 'user') throw badRequest('The last message must be a user message.');
  const text = message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
  if (!text) throw badRequest('The message is empty.');
  if (text.length > CHAT_LIMITS.userChars) {
    throw badRequest(`Messages are limited to ${CHAT_LIMITS.userChars} characters.`);
  }
  return text;
}

const sameScope = (thread: ThreadRow, scope: ToolScope) =>
  thread.workspaceId === scope.workspaceId &&
  thread.scope === scope.kind &&
  (scope.kind === 'workspace' || thread.documentId === scope.documentId);

export async function chat(
  db: Db,
  actor: Actor,
  deps: ChatDeps,
  request: Request,
): Promise<Response> {
  await limitChat(deps.rateLimiter(), actor.userId);
  const input = await readJson(request, ChatRequest);
  const text = userText(input.messages.at(-1)!);

  let scope: ToolScope;
  if (input.scope.kind === 'document') {
    const doc = await readableDocument(db, actor, input.scope.documentId);
    scope = { kind: 'document', workspaceId: doc.workspaceId, documentId: doc.id };
  } else {
    if (roleIn(actor.ctx, input.scope.workspaceId) === undefined) throw notFound('Workspace');
    scope = { kind: 'workspace', workspaceId: input.scope.workspaceId };
  }

  let thread: ThreadRow;
  if (input.threadId) {
    thread = await ownThread(db, actor, input.threadId);
    if (!sameScope(thread, scope)) throw badRequest('This thread belongs to a different scope.');
  } else {
    [thread] = (await db
      .insert(chatThread)
      .values({
        workspaceId: scope.workspaceId,
        userId: actor.userId,
        scope: scope.kind,
        documentId: scope.kind === 'document' ? scope.documentId : null,
        title: text.replace(/\s+/g, ' ').slice(0, MAX_TITLE),
      })
      .returning()) as [ThreadRow];
  }

  const userMessageId = newId();
  await db.insert(chatMessage).values({
    id: userMessageId,
    threadId: thread.id,
    role: 'user',
    partsJson: [{ type: 'text', text }],
    contextJson: { scope },
  });
  await db.update(chatThread).set({ updatedAt: new Date() }).where(eq(chatThread.id, thread.id));

  const history = trimHistory(
    (await threadMessages(db, thread.id)).map((row) => {
      const { metadata: _metadata, ...message } = toUiMessage(row, thread.id);
      return message as UIMessage;
    }),
  );
  const registry = new CitationRegistry();
  registerHistory(registry, history);
  const tools = {
    permissions: actor.ctx,
    data: createDbAssistantData(db, { search: deps.search(db) }),
    scope,
  };
  // The user's name and "About me" (4.6), as data in the context (D-20: same as enhance).
  const profile = await aiProfile(db, actor.userId);
  let documentContext: string | undefined;
  if (scope.kind === 'document') {
    const loaded = await loadDocumentContext(tools, registry, {
      me: profile.me,
      aboutMe: profile.aboutMe,
      vocabulary: profile.vocabulary,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    });
    if (!loaded) throw notFound();
    documentContext = loaded.rendered;
  }

  const model = deps.model();
  const run = await streamAssistant({
    model,
    tools,
    messages: history,
    registry,
    ...(documentContext
      ? { documentContext }
      : { profile: { aboutMe: profile.aboutMe, vocabulary: profile.vocabulary } }),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    abortSignal: request.signal,
  });

  const assistantId = newId();
  const persist = async (message: UIMessage, finishReason?: string, aborted = false) => {
    const context: StoredContext = {
      scope,
      citations: run.citations.kept,
      dropped: run.citations.dropped,
      proposals: run.proposals,
      toolCalls: message.parts
        .filter((p) => p.type.startsWith('tool-'))
        .map((p) => p.type.slice('tool-'.length)),
      ...(finishReason ? { finishReason } : {}),
      ...(aborted ? { aborted } : {}),
      model: typeof model === 'string' ? model : model.modelId,
    };
    await db.insert(chatMessage).values({
      id: assistantId,
      threadId: thread.id,
      role: 'assistant',
      partsJson: completeParts(message.parts),
      contextJson: context,
    });
    await db.update(chatThread).set({ updatedAt: new Date() }).where(eq(chatThread.id, thread.id));
  };

  return run.result.toUIMessageStreamResponse({
    originalMessages: history,
    generateMessageId: () => assistantId,
    messageMetadata: ({ part }) =>
      part.type === 'start'
        ? ({ threadId: thread.id, userMessageId } satisfies ChatMessageMetadata)
        : undefined,
    onEnd: async ({ responseMessage, finishReason, isAborted }) => {
      try {
        await persist(responseMessage, finishReason, isAborted);
      } catch (error) {
        console.error('chat: failed to save the answer', error);
      }
    },
    onError: (error) => {
      console.error('chat: generation failed', error);
      return 'The assistant ran into a problem. Please try again.';
    },
    consumeSseStream: consumeStream,
    headers: { 'cache-control': 'no-store', 'x-oat-thread-id': thread.id },
  });
}

// ---------------------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------------------

export async function decideProposal(
  db: Db,
  actor: Actor,
  threadId: string,
  proposalId: string,
  decision: 'approve' | 'reject',
): Promise<ProposalDecisionResult> {
  const thread = await ownThread(db, actor, threadId);
  const contains = JSON.stringify({ proposals: [{ id: proposalId }] });
  // Statuses are committed even when the answer is an error (stale / no longer applies).
  type Outcome = { ok: ProposalDecisionResult } | { stale: DocumentDetail } | { failed: true };
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    // Lock the message that carries the proposal: concurrent decisions on it queue up here.
    const [message] = await tx
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.threadId, thread.id),
          eq(chatMessage.role, 'assistant'),
          sql`${chatMessage.contextJson} @> ${contains}::jsonb`,
        ),
      )
      .for('update');
    const context = (message?.contextJson ?? {}) as StoredContext;
    const proposals = context.proposals ?? [];
    const index = proposals.findIndex((p) => p.id === proposalId);
    if (!message || index === -1) throw notFound('Proposal');
    const proposal = proposals[index]!;
    if (proposal.status !== 'pending') throw proposalClosed(proposal.status);

    const save = async (next: typeof proposal) => {
      const updated = proposals.map((p, i) => (i === index ? next : p));
      await tx
        .update(chatMessage)
        .set({ contextJson: { ...context, proposals: updated } })
        .where(eq(chatMessage.id, message.id));
      return next;
    };

    if (decision === 'reject') {
      return { ok: { proposal: publicProposal(await save({ ...proposal, status: 'rejected' })) } };
    }

    // Approve: through the documents API, so the same permission check and D-19 version guard apply
    // (a reader who lost edit rights gets 403 here; a deleted/unreadable document 404). Inside this
    // transaction, so the document write and the proposal status commit together. The data-access functions
    // only use the query builder, which a transaction shares with the pool client.
    const inTx = tx as unknown as Db;
    const current = await getDocument(inTx, actor, proposal.documentId);
    if (current.version !== proposal.baseVersion) {
      await save({ ...proposal, status: 'stale' });
      return { stale: current };
    }
    const edited = applyTextEdits(current.contentJson, proposal.edits);
    if (!edited.ok) {
      await save({ ...proposal, status: 'failed' });
      return { failed: true };
    }
    try {
      const updated = await updateDocument(inTx, actor, proposal.documentId, {
        baseVersion: proposal.baseVersion,
        contentJson: edited.doc,
      });
      const applied = await save({
        ...proposal,
        status: 'applied',
        appliedVersion: updated.version,
      });
      return {
        ok: {
          proposal: publicProposal(applied),
          document: { id: updated.id, version: updated.version },
        },
      };
    } catch (error) {
      // Lost a race with another write between the check above and the update.
      if (error instanceof ApiError && error.code === 'stale_version' && error.extra.document) {
        await save({ ...proposal, status: 'stale' });
        return { stale: error.extra.document };
      }
      throw error;
    }
  });
  if ('stale' in outcome) throw staleVersion(outcome.stale);
  if ('failed' in outcome) {
    throw new ApiError(409, 'proposal_closed', 'This change no longer applies to the document.');
  }
  return outcome.ok;
}

// ---------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------

type ThreadParams = { id: string };
type ProposalParams = { id: string; proposalId: string };

const ListQuery = z.object({ workspaceId: Id, documentId: Id.optional() });

export function createChatApi(deps: ApiDeps, chatDeps: ChatDeps) {
  return {
    /** `/api/chat` */
    chat: {
      POST: apiRoute(deps, async ({ db, actor, request }) => chat(db, actor, chatDeps, request)),
    },
    /** `/api/chat/threads` */
    threads: {
      GET: apiRoute(deps, async ({ db, actor, url }) => {
        const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) throw badRequest('workspaceId is required.');
        return listThreads(db, actor, {
          workspaceId: parsed.data.workspaceId,
          ...(parsed.data.documentId ? { documentId: parsed.data.documentId } : {}),
        });
      }),
    },
    /** `/api/chat/threads/[id]` */
    thread: {
      GET: apiRoute<ThreadParams>(deps, async ({ db, actor, params }) =>
        getThread(db, actor, params.id),
      ),
    },
    /** `/api/chat/threads/[id]/proposals/[proposalId]` */
    proposal: {
      POST: apiRoute<ProposalParams>(deps, async ({ db, actor, params, request }) => {
        const { decision } = await readJson(request, Decision);
        return decideProposal(db, actor, params.id, params.proposalId, decision);
      }),
    },
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
