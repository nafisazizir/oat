import 'server-only';

import { createHash } from 'node:crypto';

import {
  classifyEnhanceError,
  DEFAULT_TEMPLATE,
  type EnhanceInput,
  type EnhanceOutput,
  enhancementToDoc,
  type PreparedEnhance,
  type RunEnhanceOptions,
  prepareEnhance,
  runEnhance,
  segmentIdForRef,
} from '@oat/ai';
import { assertCan, canReadDocument } from '@oat/core';
import {
  type Db,
  document,
  type DocumentRow,
  enhancement,
  type EnhancementRow,
  meeting,
  participant,
  template,
  transcriptSegment,
} from '@oat/db';
import { ensureBlockIds, type JSONContent } from '@oat/editor';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  EnhanceErrorCode,
  EnhanceEvent,
  EnhancementDto,
  StartEnhanceInput,
  StartEnhanceResult,
} from '@/lib/enhance';

import type { Actor } from '../actor';
import { ApiError, badRequest, forbidden, notFound } from '../api/errors';
import { prepareContent } from '../documents';
import { aiProfile } from '../profile';
import type { Queryable } from '../folders';
import { ensureBuiltinTemplates } from '../templates/service';
import { snapshotBeforeReplace } from './versions';
import { type EnhanceBroker, isTerminal } from './broker';

/*
 * Enhancement jobs (D-20): `startEnhancement` checks access, snapshots the inputs (the note body becomes
 * `input_notes_json`), creates the `enhancement` row and runs generation in the background; progress goes to
 * the broker's event log, which `streamEnhancement` serves as resumable SSE.
 *
 * - One run per note at a time: the insert happens under a transaction-scoped advisory lock on the note, after
 *   checking for a live `generating` run (then that run is returned instead); the generation itself holds the
 *   broker's per-note lock. An idempotency key repeats the same run.
 * - Completion writes the output and, only if the note is still at the version the run started from, the new
 *   body (+1 version) in one transaction. If the user edited meanwhile, their body stays and the output is
 *   kept on the run (`applied: false`, the client offers to swap it in).
 * - A `generating` run older than `staleAfterMs` counts as failed (`stale`): readers mark it so lazily.
 */

type LanguageModel = RunEnhanceOptions['model'];

/** Generation is aborted after this long (SPEC §8 asks < 30 s for a 1-hour meeting; this is the hard cap). */
export const ENHANCE_TIMEOUT_MS = 2 * 60_000;
/** A run still `generating` after this long is dead (it must exceed the timeout). */
export const ENHANCE_STALE_MS = 3 * 60_000;
/** At most one preview event per this interval. */
export const PREVIEW_INTERVAL_MS = 200;

export interface EnhanceDeps {
  broker: EnhanceBroker;
  /** The `enhance` role model and its id (stored on the run). */
  model(): { model: LanguageModel; id: string };
  /** Runs the job after the response is sent (`after()` in Next.js; tests await it). */
  runInBackground(task: () => Promise<void>): void;
  staleAfterMs?: number;
  timeoutMs?: number;
  /** Server-side diagnostics (default `console.error`). */
  logError?: (message: string, error: unknown) => void;
}

/** What `output_json` holds (versioned so 4.5 can read old runs). */
export type StoredOutput =
  | {
      v: 1;
      /** Reconciled output (derived origins, dropped note lines re-inserted). */
      output: EnhanceOutput;
      /** The model's answer as returned. */
      raw: EnhanceOutput;
      /** The TipTap body this run produced. */
      doc: JSONContent;
      /** Block id → cited transcript segment ids. */
      citations: Record<string, string[]>;
      applied: boolean;
      documentVersion: number | null;
      /** Note lines the model left out (re-inserted under "Other notes"). */
      missingLines: number;
    }
  | { v: 1; error: { code: EnhanceErrorCode; message: string } };

const MESSAGES: Record<EnhanceErrorCode, string> = {
  model_error: 'The AI service didn’t respond. Try again in a moment.',
  invalid_output: 'The AI’s answer couldn’t be used. Try again.',
  timeout: 'Enhancing took too long. Try again.',
  stale: 'Enhancing stopped unexpectedly. Try again.',
  busy: 'This note is already being enhanced.',
  internal: 'Something went wrong while enhancing. Try again.',
};

const failure = (code: EnhanceErrorCode): StoredOutput => ({
  v: 1,
  error: { code, message: MESSAGES[code] },
});

export function toEnhancementDto(row: EnhancementRow): EnhancementDto {
  const out = row.outputJson as StoredOutput | null;
  const done = out && 'output' in out ? out : null;
  return {
    id: row.id,
    documentId: row.documentId,
    templateId: row.templateId,
    status: row.status,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    applied: done ? done.applied : null,
    documentVersion: done ? done.documentVersion : null,
    error: out && 'error' in out ? out.error : null,
  };
}

/** The terminal event for a finished run, from its row (readers that arrive after the live events expired). */
function terminalEvent(row: EnhancementRow): EnhanceEvent | null {
  const out = row.outputJson as StoredOutput | null;
  if (row.status === 'completed' && out && 'doc' in out) {
    return { type: 'completed', enhancement: toEnhancementDto(row), doc: out.doc };
  }
  if (row.status === 'failed') return { type: 'failed', enhancement: toEnhancementDto(row) };
  return null;
}

const staleMs = (deps: EnhanceDeps) => deps.staleAfterMs ?? ENHANCE_STALE_MS;
const timeoutMs = (deps: EnhanceDeps) => deps.timeoutMs ?? ENHANCE_TIMEOUT_MS;
/**
 * The run lock outlives the job's own timeout (plus completion time) but expires before the run counts as
 * stale, so a retry after a crash never finds the dead run's lock still held.
 */
const lockTtlMs = (deps: EnhanceDeps) =>
  Math.min(timeoutMs(deps) + 15_000, Math.max(1000, staleMs(deps) - 15_000));

/** `started_at` older than the staleness window, by the database's clock (the one that set `started_at`). */
const staleSql = (deps: EnhanceDeps) =>
  sql`${enhancement.startedAt} < now() - make_interval(secs => ${staleMs(deps) / 1000})`;

/**
 * `generating` → `failed` with `code` (only if stale by the DB clock when `onlyIfStale`); `undefined` if the
 * run already finished (or isn't stale).
 */
async function markFailed(
  db: Queryable,
  id: string,
  code: EnhanceErrorCode,
  onlyIfStale?: EnhanceDeps,
): Promise<EnhancementRow | undefined> {
  const [row] = await db
    .update(enhancement)
    .set({ status: 'failed', outputJson: failure(code), completedAt: sql`now()` })
    .where(
      and(
        eq(enhancement.id, id),
        eq(enhancement.status, 'generating'),
        onlyIfStale ? staleSql(onlyIfStale) : undefined,
      ),
    )
    .returning();
  return row;
}

/** Marks a dead run failed and tells its readers; returns the row as it now is. */
async function settleStale(
  db: Db,
  deps: EnhanceDeps,
  row: EnhancementRow,
): Promise<EnhancementRow> {
  if (row.status !== 'generating') return row;
  const failed = await markFailed(db, row.id, 'stale', deps);
  if (!failed) return (await byId(db, row.id)) ?? row;
  await deps.broker
    .publish(failed.id, { type: 'failed', enhancement: toEnhancementDto(failed) })
    .catch(() => undefined);
  return failed;
}

async function byId(db: Queryable, id: string): Promise<EnhancementRow | undefined> {
  const [row] = await db.select().from(enhancement).where(eq(enhancement.id, id));
  return row;
}

async function readableDocument(db: Db, actor: Actor, id: string): Promise<DocumentRow> {
  const [row] = await db.select().from(document).where(eq(document.id, id));
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
  return row;
}

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url');

/** Everything the run needs, read now (the inputs are a snapshot: later edits don't change this run). */
async function gatherInput(
  db: Db,
  actor: Actor,
  doc: DocumentRow,
  input: StartEnhanceInput,
  locale: string,
) {
  await ensureBuiltinTemplates(db);
  const [m] = await db.select().from(meeting).where(eq(meeting.documentId, doc.id));
  const templateId = input.templateId ?? m?.templateId ?? DEFAULT_TEMPLATE.id;
  const [tpl] = await db.select().from(template).where(eq(template.id, templateId));
  // Built-ins, or a custom template of the note's own workspace; anything else looks unknown.
  if (!tpl || (!tpl.isBuiltin && tpl.workspaceId !== doc.workspaceId)) throw notFound('Template');

  const [segments, people, profile] = await Promise.all([
    m
      ? db
          .select()
          .from(transcriptSegment)
          .where(and(eq(transcriptSegment.meetingId, m.id), eq(transcriptSegment.isFinal, true)))
          .orderBy(asc(transcriptSegment.startMs), asc(transcriptSegment.id))
      : [],
    m
      ? db
          .select()
          .from(participant)
          .where(eq(participant.meetingId, m.id))
          .orderBy(asc(participant.createdAt))
      : [],
    // The note-taker's name and "About me" (4.6): data in the prompt, like the notes.
    aiProfile(db, actor.userId),
  ]);

  const enhanceInput: EnhanceInput = {
    meta: {
      title: doc.title || 'Untitled meeting',
      startedAt: (m?.startedAt ?? doc.createdAt).toISOString(),
      endedAt: m?.endedAt?.toISOString() ?? null,
      platform: m?.platform ?? null,
      attendees: people.map((p) => ({ name: p.name, email: p.email })),
    },
    template: { name: tpl.name, instructions: tpl.instructions, sections: tpl.sectionsJson },
    myNotes: '',
    notesDoc: doc.contentJson as JSONContent,
    transcript: segments.map((s) => ({
      id: s.id,
      source: s.source,
      speakerLabel: s.speakerLabel,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
    })),
    me: profile.me,
    aboutMe: profile.aboutMe,
    vocabulary: profile.vocabulary,
    locale,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
  const prepared = prepareEnhance(enhanceInput);
  if (!prepared.lines.length && !prepared.context.transcript.segments.length) {
    throw new ApiError(
      422,
      'nothing_to_enhance',
      'There’s nothing to enhance yet: write some notes or record the meeting first.',
    );
  }
  const inputHash = hash({
    notes: doc.contentJson,
    segments: segments.map((s) => [s.id, s.text]),
    template: [tpl.id, tpl.updatedAt.toISOString()],
    people: people.map((p) => [p.name, p.email]),
    profile: [profile.me.name, profile.aboutMe, profile.vocabulary],
  });
  return { prepared, templateId: tpl.id, inputHash };
}

/**
 * `POST /api/documents/:id/enhance`: starts a run, or returns the one this key (or a live run for this note)
 * already started.
 */
export async function startEnhancement(
  db: Db,
  deps: EnhanceDeps,
  actor: Actor,
  documentId: string,
  input: StartEnhanceInput,
  options: { locale: string },
): Promise<StartEnhanceResult> {
  const doc = await readableDocument(db, actor, documentId);
  assertCan('editDocument', actor.ctx, doc);
  if (doc.deletedAt) throw forbidden('Restore this note from the trash before enhancing it.');
  if (doc.kind !== 'meeting') throw badRequest('Only meeting notes can be enhanced.');

  // Keys are scoped per (user, note): the same client key elsewhere is a different request.
  const idempotencyKey = `${actor.userId}:${doc.id}:${input.idempotencyKey}`;
  const repeat = async (row: EnhancementRow): Promise<StartEnhanceResult> => {
    if (row.documentId !== doc.id) {
      throw new ApiError(409, 'idempotency_conflict', 'This idempotency key was already used.');
    }
    return { enhancement: toEnhancementDto(await settleStale(db, deps, row)), attached: true };
  };
  const [known] = await db
    .select()
    .from(enhancement)
    .where(eq(enhancement.idempotencyKey, idempotencyKey));
  if (known) return repeat(known);

  const { prepared, templateId, inputHash } = await gatherInput(
    db,
    actor,
    doc,
    input,
    options.locale,
  );
  const { id: modelId, model } = deps.model();

  let staleRun: EnhancementRow | undefined;
  const outcome = await db.transaction(async (tx) => {
    // Serialises starts for this note across server instances (released at commit).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`enhance:${doc.id}`}, 0))`,
    );
    const [running] = await tx
      .select()
      .from(enhancement)
      .where(and(eq(enhancement.documentId, doc.id), eq(enhancement.status, 'generating')))
      .orderBy(desc(enhancement.createdAt))
      .limit(1);
    if (running) {
      const stale = await markFailed(tx, running.id, 'stale', deps);
      if (!stale) return { row: running, attached: true };
      staleRun = stale;
    }
    const [row] = await tx
      .insert(enhancement)
      .values({
        documentId: doc.id,
        templateId,
        model: modelId,
        inputHash,
        // The user's own lines only (an enhanced body's AI blocks are not "my notes").
        // Block ids as every stored body has them, so an undo writes exactly this doc (and history can tell
        // that the body is these notes).
        inputNotesJson: prepared.notesDoc
          ? ensureBlockIds(prepared.notesDoc)
          : { type: 'doc', content: [] },
        status: 'generating',
        idempotencyKey,
      })
      .onConflictDoNothing({ target: enhancement.idempotencyKey })
      .returning();
    return row ? { row, attached: false } : null;
  });
  if (!outcome) {
    // The same key won a race on another request.
    const [row] = await db
      .select()
      .from(enhancement)
      .where(eq(enhancement.idempotencyKey, idempotencyKey));
    return repeat(row!);
  }
  if (outcome.attached) {
    return { enhancement: toEnhancementDto(outcome.row), attached: true };
  }

  if (staleRun) {
    await deps.broker
      .publish(staleRun.id, { type: 'failed', enhancement: toEnhancementDto(staleRun) })
      .catch(() => undefined);
  }

  const { row } = outcome;
  let locked: boolean;
  try {
    locked = await deps.broker.lock(doc.id, row.id, lockTtlMs(deps));
    if (!locked) {
      // Held by a run the database says isn't running (crashed, timed out): take it over.
      const holder = await deps.broker.holder(doc.id);
      const held = holder ? await byId(db, holder) : undefined;
      if (holder && held?.status !== 'generating') {
        locked = await deps.broker.lock(doc.id, row.id, lockTtlMs(deps), { takeOverFrom: holder });
      }
    }
  } catch (error) {
    (deps.logError ?? console.error)('enhance: broker unavailable', error);
    await markFailed(db, row.id, 'internal');
    throw new ApiError(503, 'enhance_busy', 'Enhancing is unavailable right now. Try again.');
  }
  if (!locked) {
    await markFailed(db, row.id, 'busy');
    throw new ApiError(409, 'enhance_busy', MESSAGES.busy);
  }
  deps.runInBackground(() => runJob(db, deps, row, prepared, model, doc.version, actor.userId));
  return { enhancement: toEnhancementDto(row), attached: false };
}

/** Generation → output → note body (if unchanged since the start) → `completed`; any error → `failed`. */
export async function runJob(
  db: Db,
  deps: EnhanceDeps,
  row: EnhancementRow,
  prepared: PreparedEnhance,
  model: LanguageModel,
  baseVersion: number,
  /** Who started the run (recorded on a snapshot of the replaced body). */
  userId: string | null = null,
): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs(deps));
  let publishing: Promise<unknown> = Promise.resolve();
  try {
    const result = await runEnhance(prepared, {
      model,
      abortSignal: abort.signal,
      partialIntervalMs: PREVIEW_INTERVAL_MS,
      onPartial: (output) => {
        // In order, and a slow broker never blocks generation.
        publishing = publishing
          .then(() => deps.broker.publish(row.id, { type: 'preview', output }))
          .catch(() => undefined);
      },
    });
    const { doc, citations } = enhancementToDoc(result.output, {
      sourceLine: result.sourceLine,
      resolveRef: (ref) => segmentIdForRef(prepared.context, ref),
    });
    // The same gate as every write. Block ids are already unique, so `ensureBlockIds` keeps them and the
    // citation keys stay valid.
    const content = prepareContent(doc);

    const done = await db.transaction(async (tx) => {
      // Never lose text: the body this run replaces is saved first if it is stored nowhere (the user edited
      // the AI notes, or typed after an undo). Same row lock and version as the UPDATE below.
      await snapshotBeforeReplace(tx, row.documentId, baseVersion, 'regenerate', userId);
      const [updated] = await tx
        .update(document)
        .set({ ...content, version: sql`${document.version} + 1` })
        .where(
          and(
            eq(document.id, row.documentId),
            eq(document.version, baseVersion),
            isNull(document.deletedAt),
          ),
        )
        .returning({ version: document.version });
      const stored: StoredOutput = {
        v: 1,
        output: result.output,
        raw: result.raw,
        doc: content.contentJson,
        citations,
        applied: Boolean(updated),
        documentVersion: updated?.version ?? null,
        missingLines: result.missing.length,
      };
      const [finished] = await tx
        .update(enhancement)
        .set({ status: 'completed', outputJson: stored, completedAt: new Date() })
        .where(and(eq(enhancement.id, row.id), eq(enhancement.status, 'generating')))
        .returning();
      // Marked stale meanwhile: roll the body back too; readers were already told it failed.
      if (!finished) throw new SupersededError();
      return finished;
    });
    await publishing;
    await deps.broker.publish(row.id, {
      type: 'completed',
      enhancement: toEnhancementDto(done),
      doc: content.contentJson,
    });
  } catch (error) {
    if (error instanceof SupersededError) return;
    const code = classifyEnhanceError(error, abort.signal);
    if (code !== 'timeout') (deps.logError ?? console.error)(`enhance ${row.id}: ${code}`, error);
    await publishing;
    const failed = await markFailed(db, row.id, code).catch(() => undefined);
    if (failed) {
      await deps.broker
        .publish(row.id, { type: 'failed', enhancement: toEnhancementDto(failed) })
        .catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    await deps.broker.unlock(row.documentId, row.id).catch(() => undefined);
  }
}

class SupersededError extends Error {}

/** `GET /api/documents/:id/enhance`: the newest run of a note the actor can read (stale runs settled). */
export async function latestEnhancement(
  db: Db,
  deps: EnhanceDeps,
  actor: Actor,
  documentId: string,
): Promise<{ latest: EnhancementDto | null }> {
  const doc = await readableDocument(db, actor, documentId);
  const [row] = await db
    .select()
    .from(enhancement)
    .where(eq(enhancement.documentId, doc.id))
    .orderBy(desc(enhancement.createdAt))
    .limit(1);
  return { latest: row ? toEnhancementDto(await settleStale(db, deps, row)) : null };
}

/** How often a stream re-checks the run in Postgres (a backstop when no events arrive). */
export const STREAM_POLL_MS = 5000;
const HEARTBEAT_MS = 15_000;

/**
 * `GET /api/enhancements/:id/stream`: SSE. Replays from `lastEventId` (newest preview first), then live
 * events, and closes after the terminal one. Finished runs answer with their terminal event right away.
 */
export async function streamEnhancement(
  db: Db,
  deps: EnhanceDeps,
  actor: Actor,
  enhancementId: string,
  options: { lastEventId: string | null; signal: AbortSignal },
): Promise<Response> {
  const row = await byId(db, enhancementId);
  if (!row) throw notFound('Enhancement');
  const [doc] = await db.select().from(document).where(eq(document.id, row.documentId));
  if (!doc || !canReadDocument(actor.ctx, doc)) throw notFound('Enhancement');

  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };
      const send = (id: string, event: EnhanceEvent) =>
        write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_MS);
      let settled: EnhancementRow | undefined;
      const poll = setInterval(() => {
        void byId(db, row.id)
          .then(async (current) => {
            if (!current) return;
            const now = await settleStale(db, deps, current);
            if (now.status !== 'generating') {
              settled = now;
              stop.abort();
            }
          })
          .catch(() => undefined);
      }, STREAM_POLL_MS);

      void (async () => {
        let ended = false;
        try {
          write('retry: 2000\n\n');
          const current = await settleStale(db, deps, row);
          const final = terminalEvent(current);
          if (final) {
            send('final', final);
            ended = true;
            return;
          }
          for await (const stored of deps.broker.subscribe(
            row.id,
            options.lastEventId,
            stop.signal,
          )) {
            send(stored.id, stored.event);
            if (isTerminal(stored.event)) {
              ended = true;
              break;
            }
          }
          if (!ended && settled) {
            const event = terminalEvent(settled);
            if (event) send('final', event);
          }
        } catch (error) {
          if (!stop.signal.aborted) (deps.logError ?? console.error)('enhance stream', error);
        } finally {
          clearInterval(heartbeat);
          clearInterval(poll);
          options.signal.removeEventListener('abort', onAbort);
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
      })();
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
