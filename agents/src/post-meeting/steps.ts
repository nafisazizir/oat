/**
 * The post-meeting steps as plain functions (no eve imports): the workflow in `agent/lib/post-meeting.ts`
 * wraps each in a `"use step"` function, so eve records its result and replays it instead of running it
 * again. Each one is also safe to run twice (a crash between "did the work" and "recorded the result" re-runs
 * the step): enhance is keyed per workflow run, indexing is idempotent by content hash, and the Notion push
 * updates the page it created before (`document_export`).
 */
import { getAi } from '@oat/ai/provider';
import { document, enhancement, type EnhancementRow, integration, meeting } from '@oat/db';
import { runJob } from '@oat/indexing';
import { and, desc, eq } from 'drizzle-orm';

import type { StepContext } from './context.ts';
import { type Busy, MeetingNotFound, type MeetingRef, type StepRecord } from './types.ts';
import { ApiError, loadActor, sendToNotion, startEnhancement } from './web.ts';

const now = () => new Date().toISOString();

/**
 * The meeting and its note. `workspaceId` is the workspace the caller authorised the user against (D-29): a
 * meeting whose note lives elsewhere is reported exactly like a missing one.
 */
export async function loadMeeting(
  ctx: StepContext,
  meetingId: string,
  workspaceId: string,
): Promise<MeetingRef> {
  const [row] = await ctx.db
    .select({
      meetingId: meeting.id,
      documentId: document.id,
      workspaceId: document.workspaceId,
      ownerId: document.ownerId,
      deletedAt: document.deletedAt,
    })
    .from(meeting)
    .innerJoin(document, eq(document.id, meeting.documentId))
    .where(eq(meeting.id, meetingId));
  if (!row || row.deletedAt || row.workspaceId !== workspaceId) {
    throw new MeetingNotFound(`meeting ${meetingId} not found in workspace ${workspaceId}`);
  }
  const { deletedAt: _deleted, ...ref } = row;
  return ref;
}

async function enhancementByKey(
  ctx: StepContext,
  key: string,
): Promise<EnhancementRow | undefined> {
  const [row] = await ctx.db.select().from(enhancement).where(eq(enhancement.idempotencyKey, key));
  return row;
}

/**
 * (1) Enhance the note unless it already has a completed enhancement. Runs the web app's enhance job as the
 * note's owner, under an idempotency key derived from the workflow run: a replayed step finds the run it
 * started instead of starting another. A key whose run failed is chained (`…:<failed run id>`), so a fresh
 * attempt starts a fresh run, deterministically.
 *
 * `busy` (the workflow sleeps and asks again) while another run of the note is live: someone enhancing by
 * hand, or *our own* run from an attempt whose process died mid-generation. The latter stays `generating`
 * until D-26's staleness; the first call after that settles it as failed (`startEnhancement` → stale), and
 * this function chains the key and starts a new run in the same call.
 */
export async function ensureEnhanced(
  ctx: StepContext,
  m: MeetingRef,
  runId: string,
): Promise<StepRecord | Busy> {
  const [latest] = await ctx.db
    .select()
    .from(enhancement)
    .where(eq(enhancement.documentId, m.documentId))
    .orderBy(desc(enhancement.createdAt))
    .limit(1);
  if (latest?.status === 'completed') {
    return {
      step: 'enhance',
      outcome: 'skipped',
      reason: 'already enhanced',
      detail: { enhancementId: latest.id },
      at: now(),
    };
  }

  const actor = await loadActor(ctx.db, m.ownerId);
  // Two rounds at most: an earlier attempt's run that turns out stale now, then a fresh one.
  for (let round = 0; round < 2; round++) {
    // startEnhancement scopes client keys per (user, note): `${userId}:${documentId}:${key}`.
    let key = `post-meeting:${runId}`;
    for (;;) {
      const known = await enhancementByKey(ctx, `${m.ownerId}:${m.documentId}:${key}`);
      if (known?.status !== 'failed') break;
      key = `${key}:${known.id}`;
    }

    let job: Promise<void> | undefined;
    let started;
    try {
      started = await startEnhancement(
        ctx.db,
        { ...ctx.enhance, runInBackground: (task) => void (job = task()) },
        actor,
        m.documentId,
        { idempotencyKey: key },
        { locale: 'en' },
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'nothing_to_enhance') {
        return { step: 'enhance', outcome: 'skipped', reason: 'nothing to enhance', at: now() };
      }
      if (error instanceof ApiError && (error.status === 409 || error.status === 503)) {
        return { busy: `enhance: ${error.code}` };
      }
      throw error;
    }
    // Our run (this call started it): its generation runs right here, inside the step.
    if (job) await job;
    const [row] = await ctx.db
      .select()
      .from(enhancement)
      .where(eq(enhancement.id, started.enhancement.id));
    if (row?.status === 'generating') return { busy: 'enhance: a run of this note is in progress' };
    if (row?.status === 'completed') {
      const out = row.outputJson as { applied?: boolean } | null;
      return {
        step: 'enhance',
        outcome: 'ran',
        detail: { enhancementId: row.id, applied: out?.applied ?? false },
        at: now(),
      };
    }
    // Failed, and not started by this call: an earlier attempt's run, just settled as stale → chain, start anew.
    if (!job) continue;
    const code = (row?.outputJson as { error?: { code?: string } } | null)?.error?.code;
    // A real generation failure: the step's normal retries apply (the next attempt chains the key).
    throw new Error(`enhance failed (${code ?? 'unknown'})`);
  }
  throw new Error('enhance: could not start a run');
}

/**
 * (2) Index the note now, exactly as the change-log worker's job for it would (6.1 + 8.4): re-extract its
 * action items (`action_item` rows, "My tasks") and embed new chunks of the enhanced notes and the transcript.
 * Running it here means "My tasks", chat and search see the meeting as soon as the pipeline finishes instead
 * of after the worker's next pass. Idempotent: unchanged items/chunks are kept, so a replay (or the worker's
 * own pass) writes and embeds nothing.
 */
export async function indexNotes(ctx: StepContext, m: MeetingRef): Promise<StepRecord> {
  const result = await runJob(
    { db: ctx.db, embeddingModel: getAi().getEmbeddingModel() },
    { kind: 'document', id: m.documentId },
  );
  const items =
    result.actionItems && result.actionItems.status !== 'missing' ? result.actionItems : null;
  return {
    step: 'index',
    outcome: result.status === 'missing' ? 'skipped' : 'ran',
    ...(result.status === 'missing' ? { reason: 'note deleted' } : {}),
    detail: {
      inserted: result.inserted,
      updated: result.updated,
      deleted: result.deleted,
      truncated: result.truncated,
      actionItemsWritten: items ? items.inserted + items.updated + items.deleted : 0,
      actionItemsUnchanged: items ? items.unchanged : 0,
    },
    at: now(),
  };
}

/** Notion connection settings this step reads (8.3 adds `autoPush` to the web app's settings schema + UI). */
interface AutoPushSettings {
  autoPush?: unknown;
}

/**
 * (3) Push the note to Notion when the owner's Notion connection for the note's workspace has auto-push on.
 * Not connected / auto-push off / no target / needs reconnect are `skipped` (the run still succeeds: there is
 * nothing a retry could fix); another push holding the lease, or a rate limit, is `busy`.
 */
export async function pushToNotion(ctx: StepContext, m: MeetingRef): Promise<StepRecord | Busy> {
  const skipped = (reason: string): StepRecord => ({
    step: 'notion',
    outcome: 'skipped',
    reason,
    at: now(),
  });
  const [row] = await ctx.db
    .select()
    .from(integration)
    .where(
      and(
        eq(integration.workspaceId, m.workspaceId),
        eq(integration.userId, m.ownerId),
        eq(integration.provider, 'notion'),
      ),
    );
  if (!row) return skipped('not connected');
  if ((row.settingsJson as AutoPushSettings).autoPush !== true) return skipped('auto-push off');

  const actor = await loadActor(ctx.db, m.ownerId);
  try {
    const result = await sendToNotion(ctx.notion, actor, m.documentId);
    return {
      step: 'notion',
      outcome: 'ran',
      detail: { url: result.url, created: result.created, pushedVersion: result.pushedVersion },
      at: now(),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'notion_busy' || error.code === 'rate_limited') {
        return { busy: `notion: ${error.code}` };
      }
      if (
        error.code === 'notion_not_connected' ||
        error.code === 'notion_no_target' ||
        error.code === 'notion_reconnect' ||
        error.code === 'not_configured'
      ) {
        return skipped(error.code);
      }
    }
    throw error;
  }
}
