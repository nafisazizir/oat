import 'server-only';

import { canReadDocument, type SyncEvent } from '@oat/core';
import {
  type Db,
  decodeCursor,
  document,
  headCursor,
  meeting,
  participant,
  readChanges,
  transcriptSegment,
} from '@oat/db';
import { eq, inArray } from 'drizzle-orm';

import { type Actor, loadActor } from '../actor';
import { ApiError } from '../api/errors';

/*
 * `GET /api/sync/events` (D-19 realtime, 3.5): a per-user SSE *invalidation* channel. It follows the change
 * log (D-22, same visibility rule as pulls) of the workspaces the user belongs to and says what changed —
 * `event: change`, `data: {seq, tables, ids}`, `id: <seq>` — never the rows: clients pull (desktop) or
 * re-render (web) on it. `ids` are the affected documents the user can read right now (a meeting, segment
 * or participant change names its document); changes the user can't read add only their table name.
 *
 * - Replay: `Last-Event-ID` (or `?lastEventId=`, for the first connect) is a change-log cursor; events
 *   after it are sent first. Without one (or an unusable one) the stream starts at the current end and
 *   the first event (`ready`) carries that cursor as its id.
 * - Membership: the user's workspaces are re-read every `membershipEveryMs` (2 s) and before resolving the
 *   ids of every page of changes (a removed member never gets ids of that workspace). A change emits
 *   `{workspaces: true, tables: ['workspace']}` and moves the cursor to the current end of the new set
 *   (joining a workspace: its history is behind any cursor, and the client's pull restarts anyway — see
 *   `LocalStore.applyPull` — so it is never replayed through the stream).
 * - Session: re-checked every `sessionEveryMs` (30 s); a signed-out / revoked session ends the stream.
 * - Limits (review 3.5): connects are rate-limited per user (route, `apiRateLimiter`) and at most
 *   `maxStreamsPerUser` streams are open per user per server process ({@link StreamRegistry}; 429 past it).
 *   Web tabs close theirs while hidden.
 * - Heartbeat comment every 15 s; the stream ends after `maxMs` (the platform's function limit), and
 *   `retry: 2000` makes EventSource reconnect with `Last-Event-ID`. Polling is per connection, every
 *   `pollMs` (one indexed query + one small join when something changed): fine for small-team fan-out;
 *   a shared poller / LISTEN can replace it.
 */

export interface SyncEventsTimings {
  pollMs?: number;
  membershipEveryMs?: number;
  sessionEveryMs?: number;
  heartbeatMs?: number;
  maxMs?: number;
}

export interface SyncEventsOptions extends SyncEventsTimings {
  lastEventId: string | null;
  signal: AbortSignal;
  /** Whether the request's session is still valid (re-checked every `sessionEveryMs`). */
  sessionValid?: () => Promise<boolean>;
  /** Releases this stream's slot in the {@link StreamRegistry} when the stream ends. */
  onClose?: () => void;
}

const DEFAULTS = {
  pollMs: 1_000,
  membershipEveryMs: 2_000,
  sessionEveryMs: 30_000,
  heartbeatMs: 15_000,
  maxMs: 270_000,
};

/** Concurrent streams per user in this server process. */
export class StreamRegistry {
  readonly #open = new Map<string, number>();
  constructor(readonly maxPerUser = 5) {}

  /** Takes a slot for `userId` (429 past the cap); call the returned function once when it ends. */
  acquire(userId: string): () => void {
    const n = this.#open.get(userId) ?? 0;
    if (n >= this.maxPerUser) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many live sync connections; close another tab or window.',
        { retryAfter: 30 },
      );
    }
    this.#open.set(userId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#open.get(userId) ?? 1) - 1;
      if (left <= 0) this.#open.delete(userId);
      else this.#open.set(userId, left);
    };
  }

  count(userId: string): number {
    return this.#open.get(userId) ?? 0;
  }
}

/** A usable resume cursor (the format `readChanges` issues, in range), else `null`. */
export function resumeCursor(value: string | null): string | null {
  if (!value || value.length > 64) return null;
  try {
    const { txid, seq } = decodeCursor(value);
    if (BigInt(txid) > 2n ** 64n - 1n || BigInt(seq) > 2n ** 63n - 1n) return null;
    return value;
  } catch {
    return null;
  }
}

const workspacesOf = (actor: Actor) => [...actor.ctx.memberships.keys()].sort();

/** Only what `canReadDocument` needs: never the body. */
const accessColumns = {
  id: document.id,
  workspaceId: document.workspaceId,
  ownerId: document.ownerId,
  visibility: document.visibility,
  shareToken: document.shareToken,
  deletedAt: document.deletedAt,
};

/** Readable document ids behind a page of changes (three narrow joined lookups at most). */
export async function readableDocuments(
  db: Db,
  actor: Actor,
  changes: { tableName: string; rowId: string }[],
): Promise<string[]> {
  const ids = (table: string) => [
    ...new Set(changes.filter((c) => c.tableName === table).map((c) => c.rowId)),
  ];
  const docs: { id: string }[] = [];
  const consider = (rows: AccessRow[]) => {
    for (const d of rows) if (canReadDocument(actor.ctx, d)) docs.push(d);
  };
  const docIds = ids('document');
  const meetingIds = ids('meeting');
  const segIds = ids('transcript_segment');
  const partIds = ids('participant');
  if (docIds.length) {
    consider(await db.select(accessColumns).from(document).where(inArray(document.id, docIds)));
  }
  if (meetingIds.length) {
    consider(
      await db
        .select(accessColumns)
        .from(meeting)
        .innerJoin(document, eq(document.id, meeting.documentId))
        .where(inArray(meeting.id, meetingIds)),
    );
  }
  if (segIds.length) {
    consider(
      await db
        .selectDistinct(accessColumns)
        .from(transcriptSegment)
        .innerJoin(meeting, eq(meeting.id, transcriptSegment.meetingId))
        .innerJoin(document, eq(document.id, meeting.documentId))
        .where(inArray(transcriptSegment.id, segIds)),
    );
  }
  if (partIds.length) {
    consider(
      await db
        .selectDistinct(accessColumns)
        .from(participant)
        .innerJoin(meeting, eq(meeting.id, participant.meetingId))
        .innerJoin(document, eq(document.id, meeting.documentId))
        .where(inArray(participant.id, partIds)),
    );
  }
  return [...new Set(docs.map((d) => d.id))].sort();
}

type AccessRow = {
  id: string;
  workspaceId: string;
  ownerId: string;
  visibility: 'private' | 'workspace' | 'link';
  shareToken: string | null;
  deletedAt: Date | null;
};

export function streamSyncEvents(db: Db, initial: Actor, options: SyncEventsOptions): Response {
  const o = { ...DEFAULTS, ...options };
  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stop.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        stop.signal.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      stop.signal.addEventListener('abort', done, { once: true });
    });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
          stop.abort();
        }
      };
      const send = (id: string | null, event: string, data: unknown) =>
        write(
          `${id !== null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      const heartbeat = setInterval(() => write(': keep-alive\n\n'), o.heartbeatMs);
      const deadline = setTimeout(() => stop.abort(), o.maxMs);

      void (async () => {
        try {
          write('retry: 2000\n\n');
          let actor = initial;
          let workspaces = workspacesOf(actor);
          let cursor = resumeCursor(options.lastEventId);
          if (cursor === null) {
            cursor = await headCursor(db, workspaces);
            send(cursor, 'ready', { seq: cursor });
          } else {
            send(null, 'ready', { seq: cursor });
          }
          let lastMembershipCheck = Date.now();
          let lastSessionCheck = Date.now();
          /** Re-reads memberships; on a change announces it and jumps to the new set's current end. */
          const refreshActor = async (): Promise<boolean> => {
            lastMembershipCheck = Date.now();
            actor = await loadActor(db, actor.userId);
            const now = workspacesOf(actor);
            if (now.join() === workspaces.join()) return false;
            workspaces = now;
            cursor = await headCursor(db, workspaces);
            const event: SyncEvent = {
              seq: cursor ?? '',
              tables: ['workspace'],
              ids: [],
              workspaces: true,
            };
            send(cursor, 'change', event);
            return true;
          };
          while (!stop.signal.aborted) {
            if (options.sessionValid && Date.now() - lastSessionCheck >= o.sessionEveryMs) {
              lastSessionCheck = Date.now();
              if (!(await options.sessionValid())) break; // signed out / revoked: end the stream
            }
            if (Date.now() - lastMembershipCheck >= o.membershipEveryMs) await refreshActor();
            const page = await readChanges(db, workspaces, cursor, { limit: 500 });
            if (page.changes.length > 0 && !stop.signal.aborted) {
              // Fresh memberships before naming ids (a member removed a moment ago gets none); if they
              // changed, the cursor moved to the new set's end and this page is moot.
              if (await refreshActor()) continue;
              const event: SyncEvent = {
                seq: page.cursor!,
                tables: [...new Set(page.changes.map((c) => c.tableName))].sort(),
                ids: await readableDocuments(db, actor, page.changes),
              };
              cursor = page.cursor;
              send(cursor, 'change', event);
            }
            if (!page.hasMore) await sleep(o.pollMs);
          }
        } catch (error) {
          if (!stop.signal.aborted) console.error('[sync] events stream', error);
        } finally {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          options.signal.removeEventListener('abort', onAbort);
          options.onClose?.();
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
