import 'server-only';

import {
  canReadDocument,
  MAX_PULL_LIMIT,
  roleIn,
  SYNC_PULL_TABLES,
  type SyncPullChange,
  type SyncPullResponse,
  type SyncPullTable,
} from '@oat/core';
import {
  type Db,
  decodeCursor,
  document,
  type DocumentRow,
  hasHeldBackChanges,
  longTransactions,
  meeting,
  type MeetingRow,
  participant,
  readChanges,
  transcriptSegment,
  workspace,
} from '@oat/db';
import { eq, inArray } from 'drizzle-orm';

import type { Actor } from '../actor';
import { ApiError } from '../api/errors';
import { toSyncDocument } from './push';

/*
 * `GET /api/sync/pull?cursor=` (D-19/D-22, task 2.6; the full version with SSE is 3.5). Reads the change
 * log of the actor's workspaces after the cursor (`readChanges`: only transactions older than every
 * running one, so nothing committed late is skipped), keeps the last change per row, and answers with
 * each row's **current** state — or a `delete` when it is gone or the actor can no longer read it (a
 * document turned private by its owner, a meeting whose document went to someone else's trash…). Rows
 * of tables the protocol doesn't carry yet are skipped (clients re-pull from the start when the scope
 * grows, `SYNC_PULL_SCOPE`). `workspaceIds` lets the client drop the content of workspaces it left.
 * Workspace rows carry the actor's role (3.9); a membership change in a workspace re-sends its row.
 *
 * 3.5: a last page that comes back while committed changes are still held back by an open transaction
 * (D-22 visibility rule) says `lagging: true` — the client pulls again shortly — and logs the long
 * transactions that cause it (at most every 30 s per server process).
 */

const LONG_TX_LOG_EVERY_MS = 30_000;
let lastLongTxLog = 0;

/** Logs transactions old enough to hold back every change-log reader (throttled). */
async function logLongTransactions(db: Db): Promise<void> {
  const now = Date.now();
  if (now - lastLongTxLog < LONG_TX_LOG_EVERY_MS) return;
  lastLongTxLog = now;
  try {
    const long = await longTransactions(db, 5_000);
    if (long.length === 0) return;
    console.warn(
      `[sync] pulls are lagging: ${long.length} open transaction(s) hold back the change log`,
      long.map((t) => ({
        pid: t.pid,
        ageSeconds: Math.round(t.ageSeconds),
        state: t.state,
        app: t.applicationName,
        db: t.database,
      })),
    );
  } catch {
    // diagnostics only
  }
}

export function toSyncMeeting(m: MeetingRow) {
  return {
    id: m.id,
    documentId: m.documentId,
    calendarEventId: m.calendarEventId,
    startedAt: m.startedAt?.toISOString() ?? null,
    endedAt: m.endedAt?.toISOString() ?? null,
    platform: m.platform,
    templateId: m.templateId,
  };
}

const PULL_TABLES: ReadonlySet<string> = new Set(SYNC_PULL_TABLES);

/** 409 `stale_cursor`: the client must start over from `null` (D-19). */
const staleCursor = () =>
  new ApiError(409, 'stale_cursor', 'Sync cursor is no longer valid; pull from the beginning.');

export async function pullChanges(
  db: Db,
  actor: Actor,
  cursor: string | null,
  limit = MAX_PULL_LIMIT,
): Promise<SyncPullResponse> {
  if (cursor !== null) {
    let parts: { txid: string; seq: string };
    try {
      parts = decodeCursor(cursor);
    } catch {
      throw staleCursor();
    }
    // In range for `xid8` / `bigint`, or Postgres would fail the cast (a 500 instead of a restart).
    if (BigInt(parts.txid) > 2n ** 64n - 1n || BigInt(parts.seq) > 2n ** 63n - 1n) {
      throw staleCursor();
    }
  }
  const workspaceIds = [...actor.ctx.memberships.keys()].sort();
  const page = await readChanges(db, workspaceIds, cursor, {
    limit: Math.min(Math.max(1, limit), MAX_PULL_LIMIT),
  });

  // The last change per row decides (its current state is what we send), in the order of that change.
  const latest = new Map<string, { table: SyncPullTable; id: string }>();
  for (const change of page.changes) {
    // 3.9: a membership change in one of my workspaces re-sends that workspace's row (it carries my role).
    const [table, id] =
      change.tableName === 'membership'
        ? (['workspace', change.workspaceId] as const)
        : [change.tableName, change.rowId];
    if (!PULL_TABLES.has(table)) continue;
    const key = `${table}:${id}`;
    latest.delete(key);
    latest.set(key, { table: table as SyncPullTable, id });
  }
  const ids = (table: SyncPullTable) =>
    [...latest.values()].filter((c) => c.table === table).map((c) => c.id);

  const rows = await loadReadable(db, actor, {
    workspace: ids('workspace'),
    document: ids('document'),
    meeting: ids('meeting'),
    participant: ids('participant'),
    transcript_segment: ids('transcript_segment'),
  });

  const changes: SyncPullChange[] = [...latest.values()].map(({ table, id }) => {
    const row = rows.get(`${table}:${id}`);
    return row ?? { op: 'delete', table, id };
  });
  const lagging = !page.hasMore && (await hasHeldBackChanges(db, workspaceIds, page.cursor));
  if (lagging) void logLongTransactions(db);
  return {
    changes,
    cursor: page.cursor,
    hasMore: page.hasMore,
    workspaceIds,
    ...(lagging ? { lagging: true } : {}),
  };
}

/** Current rows the actor can read, keyed `table:id`, as upsert changes. */
async function loadReadable(
  db: Db,
  actor: Actor,
  ids: Record<SyncPullTable, string[]>,
): Promise<Map<string, SyncPullChange>> {
  const out = new Map<string, SyncPullChange>();
  const readable = (doc: DocumentRow) => canReadDocument(actor.ctx, doc);

  if (ids.workspace.length) {
    const rows = await db.select().from(workspace).where(inArray(workspace.id, ids.workspace));
    for (const w of rows) {
      const role = roleIn(actor.ctx, w.id);
      if (w.deletedAt || role === undefined) continue;
      out.set(`workspace:${w.id}`, {
        op: 'upsert',
        table: 'workspace',
        row: { id: w.id, name: w.name, kind: w.kind, role },
      });
    }
  }
  if (ids.document.length) {
    const rows = await db.select().from(document).where(inArray(document.id, ids.document));
    for (const d of rows) {
      if (!readable(d)) continue;
      out.set(`document:${d.id}`, { op: 'upsert', table: 'document', row: toSyncDocument(d) });
    }
  }
  if (ids.meeting.length) {
    const rows = await db
      .select({ m: meeting, doc: document })
      .from(meeting)
      .innerJoin(document, eq(document.id, meeting.documentId))
      .where(inArray(meeting.id, ids.meeting));
    for (const { m, doc } of rows) {
      if (!readable(doc)) continue;
      out.set(`meeting:${m.id}`, { op: 'upsert', table: 'meeting', row: toSyncMeeting(m) });
    }
  }
  if (ids.participant.length) {
    const rows = await db
      .select({ p: participant, doc: document })
      .from(participant)
      .innerJoin(meeting, eq(meeting.id, participant.meetingId))
      .innerJoin(document, eq(document.id, meeting.documentId))
      .where(inArray(participant.id, ids.participant));
    for (const { p, doc } of rows) {
      if (!readable(doc)) continue;
      out.set(`participant:${p.id}`, {
        op: 'upsert',
        table: 'participant',
        row: { id: p.id, meetingId: p.meetingId, name: p.name, email: p.email, source: p.source },
      });
    }
  }
  if (ids.transcript_segment.length) {
    const rows = await db
      .select({ s: transcriptSegment, doc: document })
      .from(transcriptSegment)
      .innerJoin(meeting, eq(meeting.id, transcriptSegment.meetingId))
      .innerJoin(document, eq(document.id, meeting.documentId))
      .where(inArray(transcriptSegment.id, ids.transcript_segment));
    for (const { s, doc } of rows) {
      // Interims (never written by sync) and empty text don't travel (D-19: only finals).
      if (!readable(doc) || !s.isFinal || s.text === '') continue;
      out.set(`transcript_segment:${s.id}`, {
        op: 'upsert',
        table: 'transcript_segment',
        row: {
          id: s.id,
          meetingId: s.meetingId,
          source: s.source,
          speakerLabel: s.speakerLabel,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        },
      });
    }
  }
  return out;
}
