/**
 * `LocalStore`: the desktop's SQLite cache (D-19, D-28; one file per user) — repositories for the synced
 * tables and the sync primitives the `SyncEngine` drives (`audio_recording` lives in `AudioIndex`):
 *
 * - `takePushBatch(n, bytes)` reads the unparked outbox (parents first: documents, meetings, participants,
 *   segments; then by version), at most `n` entries and about `bytes` of JSON, and joins each entry with
 *   its current row. An `upsert` whose row is gone is dropped.
 * - Parking (D-28): an entry the server rejects, or one that alone breaks a push (400/413/5xx after
 *   bisection), is parked — kept, skipped by pushes, counted in the status, retried later
 *   (`unparkOlderThan`, when its meeting's note changes on the server, or when the row is edited again).
 *   Nothing is silently dropped and nothing blocks the queue.
 * - `applyPushResults(entries, results)` deletes acknowledged entries **by version** (a newer edit of the
 *   same row has a newer version and survives), stores the server's document version, keeps the server
 *   copy on a conflict (the local text becomes a "conflicted copy" page unless identical) and parks
 *   rejected entries.
 * - `applyPull(page)` applies a pull page in one transaction with `applying_remote` set (no echo):
 *   remote upserts skip rows with a pending local edit (it is pushed next and resolved there), remote
 *   deletes win and clear the row's outbox entry; children whose parent never arrived are dropped; the
 *   cursor moves only with the rows. Workspaces the user left are dropped with their content; a workspace
 *   the user joined restarts the pull from the beginning (its history is behind our cursor).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  type DocumentKind,
  type DocumentVisibility,
  sameDocumentContent,
  SYNC_PULL_SCOPE,
  SYNC_PULL_TABLES,
  type SyncDocumentRow,
  type SyncMeetingRow,
  type SyncParticipantRow,
  type SyncPullResponse,
  type SyncPushEntry,
  type SyncPushResult,
  type SyncSegmentRow,
  type SyncWorkspaceRow,
  type TranscriptSource,
  type WorkspaceKind,
} from '@oat/core';

import { MIGRATIONS, OUTBOX_TABLES } from './migrations.ts';
import { openDatabase, type OpenLogger, type WipeReason } from './open.ts';
import { uuidv7 } from './uuid.ts';

export type OutboxTable = (typeof OUTBOX_TABLES)[number];

export interface LocalWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
}

export interface LocalDocument {
  id: string;
  workspaceId: string;
  folderId: string | null;
  ownerId: string;
  kind: DocumentKind;
  title: string;
  contentJson: { type: 'doc'; [key: string]: unknown };
  visibility: DocumentVisibility;
  /** Server version this row is based on (0 = never acknowledged). */
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type LocalMeeting = SyncMeetingRow;

export interface LocalSegment {
  id: string;
  meetingId: string;
  source: TranscriptSource;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export type LocalParticipant = SyncParticipantRow;

export interface OutboxEntry {
  version: number;
  table: OutboxTable;
  rowId: string;
  op: 'upsert' | 'delete';
  parked: boolean;
}

export interface LocalStoreOptions {
  /** Database file, or `:memory:` (tests). */
  path: string;
  log?: OpenLogger & { info?(message: string): void };
  /** Wall clock (Unix ms). */
  now?: () => number;
  newId?: () => string;
  /** How long a statement waits for a lock held by another connection. Default 5 s. */
  busyTimeoutMs?: number;
}

export interface PushOutcome {
  acknowledged: number;
  conflicts: number;
  /** Rejected by the server, now parked. */
  rejected: number;
  /** Conflicted copies created (documents whose local text differed from the server copy). */
  copies: string[];
}

/** A new document's body: what the editor's `emptyDoc()` is (one empty paragraph). */
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] } as const;
const TABLE_RANK: Record<OutboxTable, number> = {
  document: 0,
  meeting: 1,
  participant: 2,
  transcript_segment: 3,
};

/** Table names that may appear in SQL built from a pull change (they are also schema-checked upstream). */
const PULL_TABLES: ReadonlySet<string> = new Set(SYNC_PULL_TABLES);

const STATE = {
  cursor: 'pull.cursor',
  scope: 'pull.scope',
  workspaces: 'pull.workspaces',
} as const;

type Row = Record<string, SQLInputValue>;

export class LocalStore {
  #db: DatabaseSync;
  readonly #log: LocalStoreOptions['log'];
  readonly #now: () => number;
  readonly #newId: () => string;
  #wiped: WipeReason | null;
  #depth = 0;

  constructor(options: LocalStoreOptions) {
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => uuidv7(this.#now()));
    const opened = openDatabase(options.path, options.log, MIGRATIONS, {
      ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
    });
    this.#db = opened.db;
    this.#wiped = opened.wiped;
  }

  /** Why the file found at open time was thrown away, if it was. */
  get wiped(): WipeReason | null {
    return this.#wiped;
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  // --- plumbing ---------------------------------------------------------------------------------------

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  #run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  /** Runs `fn` in a transaction (a savepoint when nested). */
  transaction<T>(fn: () => T): T {
    const name = `sp${this.#depth}`;
    this.#db.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.#depth += 1;
    try {
      const result = fn();
      this.#depth -= 1;
      this.#db.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#depth -= 1;
      this.#db.exec(this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  /** Writes that come from the server: the outbox triggers stay quiet. */
  #remote<T>(fn: () => T): T {
    return this.transaction(() => {
      this.#run('UPDATE sync_control SET applying_remote = 1 WHERE id = 1');
      try {
        return fn();
      } finally {
        this.#run('UPDATE sync_control SET applying_remote = 0 WHERE id = 1');
      }
    });
  }

  getState(key: string): string | null {
    const row = this.#get('SELECT value FROM sync_state WHERE key = ?', key);
    return row ? String(row.value) : null;
  }

  setState(key: string, value: string | null): void {
    if (value === null) this.#run('DELETE FROM sync_state WHERE key = ?', key);
    else
      this.#run(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
  }

  // --- workspaces --------------------------------------------------------------------------------------

  workspaces(): LocalWorkspace[] {
    return this.#all('SELECT id, name, kind FROM workspace ORDER BY name, id').map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as WorkspaceKind,
    }));
  }

  /** The user's personal workspace (exactly one per user; pulled from the server). */
  personalWorkspaceId(): string | null {
    const row = this.#get("SELECT id FROM workspace WHERE kind = 'personal' LIMIT 1");
    return row ? String(row.id) : null;
  }

  // --- documents + meetings ----------------------------------------------------------------------------

  document(id: string): LocalDocument | undefined {
    const r = this.#get('SELECT * FROM document WHERE id = ?', id);
    return r && toDocument(r);
  }

  documents(workspaceId?: string): LocalDocument[] {
    const rows = workspaceId
      ? this.#all('SELECT * FROM document WHERE workspace_id = ? ORDER BY created_at', workspaceId)
      : this.#all('SELECT * FROM document ORDER BY created_at');
    return rows.map(toDocument);
  }

  meeting(id: string): LocalMeeting | undefined {
    const r = this.#get('SELECT * FROM meeting WHERE id = ?', id);
    return r && toMeeting(r);
  }

  /**
   * A meeting and its (private, root-level) `meeting` document, created together. Idempotent: returns
   * `false` when the meeting already exists.
   */
  createMeeting(input: {
    meetingId: string;
    documentId: string;
    workspaceId: string;
    ownerId: string;
    title: string;
    startedAt: string | null;
  }): boolean {
    return this.transaction(() => {
      if (this.meeting(input.meetingId)) return false;
      const at = this.#iso();
      this.#run(
        `INSERT INTO document (id, workspace_id, owner_id, kind, title, content_json, visibility, version, created_at, updated_at)
         VALUES (?, ?, ?, 'meeting', ?, ?, 'private', 0, ?, ?)`,
        input.documentId,
        input.workspaceId,
        input.ownerId,
        input.title,
        JSON.stringify(EMPTY_DOC),
        at,
        at,
      );
      this.#run(
        'INSERT INTO meeting (id, document_id, started_at) VALUES (?, ?, ?)',
        input.meetingId,
        input.documentId,
        input.startedAt,
      );
      return true;
    });
  }

  updateMeeting(
    id: string,
    patch: Partial<Pick<LocalMeeting, 'startedAt' | 'endedAt' | 'platform' | 'calendarEventId'>>,
  ): boolean {
    const current = this.meeting(id);
    if (!current) return false;
    const next = { ...current, ...definedOnly(patch) };
    if (
      next.startedAt === current.startedAt &&
      next.endedAt === current.endedAt &&
      next.platform === current.platform &&
      next.calendarEventId === current.calendarEventId
    ) {
      return false;
    }
    this.#run(
      'UPDATE meeting SET started_at = ?, ended_at = ?, platform = ?, calendar_event_id = ? WHERE id = ?',
      next.startedAt,
      next.endedAt,
      next.platform,
      next.calendarEventId,
      id,
    );
    return true;
  }

  updateDocument(
    id: string,
    patch: { title?: string; contentJson?: LocalDocument['contentJson'] },
  ): boolean {
    const current = this.document(id);
    if (!current) return false;
    const title = patch.title ?? current.title;
    const content = patch.contentJson ?? current.contentJson;
    if (
      title === current.title &&
      JSON.stringify(content) === JSON.stringify(current.contentJson)
    ) {
      return false;
    }
    this.#run(
      'UPDATE document SET title = ?, content_json = ?, updated_at = ? WHERE id = ?',
      title,
      JSON.stringify(content),
      this.#iso(),
      id,
    );
    return true;
  }

  // --- transcript ---------------------------------------------------------------------------------------

  /**
   * Stores a **final** segment (D-19: a final replaces its interim; interims never reach the database).
   * Rewriting identical content is a no-op, so nothing is re-queued. A segment id belongs to one meeting
   * forever.
   */
  saveSegment(segment: LocalSegment): 'inserted' | 'updated' | 'unchanged' {
    const existing = this.#get('SELECT * FROM transcript_segment WHERE id = ?', segment.id);
    if (existing) {
      const cur = toSegment(existing);
      if (cur.meetingId !== segment.meetingId) {
        throw new Error(`segment ${segment.id} belongs to another meeting`);
      }
      if (
        cur.source === segment.source &&
        cur.speakerLabel === segment.speakerLabel &&
        cur.startMs === segment.startMs &&
        cur.endMs === segment.endMs &&
        cur.text === segment.text
      ) {
        return 'unchanged';
      }
      this.#run(
        'UPDATE transcript_segment SET source = ?, speaker_label = ?, start_ms = ?, end_ms = ?, text = ? WHERE id = ?',
        segment.source,
        segment.speakerLabel,
        segment.startMs,
        segment.endMs,
        segment.text,
        segment.id,
      );
      return 'updated';
    }
    this.#run(
      `INSERT INTO transcript_segment (id, meeting_id, source, speaker_label, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      segment.id,
      segment.meetingId,
      segment.source,
      segment.speakerLabel,
      segment.startMs,
      segment.endMs,
      segment.text,
    );
    return 'inserted';
  }

  /** A retraction (empty final). */
  deleteSegment(id: string): boolean {
    return this.#run('DELETE FROM transcript_segment WHERE id = ?', id) > 0;
  }

  segments(meetingId: string): LocalSegment[] {
    return this.#all(
      'SELECT * FROM transcript_segment WHERE meeting_id = ? ORDER BY start_ms, id',
      meetingId,
    ).map(toSegment);
  }

  participants(meetingId: string): LocalParticipant[] {
    return this.#all('SELECT * FROM participant WHERE meeting_id = ? ORDER BY id', meetingId).map(
      toParticipant,
    );
  }

  saveParticipant(p: LocalParticipant): void {
    this.#run(
      `INSERT INTO participant (id, meeting_id, name, email, source) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, source = excluded.source
       WHERE participant.meeting_id = excluded.meeting_id`,
      p.id,
      p.meetingId,
      p.name,
      p.email,
      p.source,
    );
  }

  deleteParticipant(id: string): boolean {
    return this.#run('DELETE FROM participant WHERE id = ?', id) > 0;
  }

  // --- outbox + push --------------------------------------------------------------------------------------

  /** Entries waiting to be pushed (not parked). */
  outboxSize(): number {
    return Number(this.#get('SELECT count(*) AS n FROM outbox WHERE parked_at IS NULL')!.n);
  }

  /** Entries parked because they can't be sent as they are (see the module comment). */
  parkedCount(): number {
    return Number(this.#get('SELECT count(*) AS n FROM outbox WHERE parked_at IS NOT NULL')!.n);
  }

  /** Parks entries by version (a newer entry for the same row, with another version, is unaffected). */
  park(versions: readonly number[], reason: string): void {
    const at = this.#now();
    this.transaction(() => {
      for (const v of versions) {
        this.#run(
          'UPDATE outbox SET parked_at = ?, park_reason = ? WHERE version = ?',
          at,
          reason.slice(0, 500),
          v,
        );
      }
    });
    if (versions.length) {
      this.#log?.warn(`local-store: parked ${versions.length} outbox entr(y/ies): ${reason}`);
    }
  }

  /** Puts entries parked before `time` (Unix ms) back in the queue. Returns how many. */
  unparkOlderThan(time: number): number {
    return this.#run(
      'UPDATE outbox SET parked_at = NULL, park_reason = NULL WHERE parked_at IS NOT NULL AND parked_at < ?',
      time,
    );
  }

  /** Puts the parked entries of a meeting note's rows (document, meeting, participants, segments) back. */
  unparkDocument(documentId: string): number {
    return this.#run(
      `UPDATE outbox SET parked_at = NULL, park_reason = NULL
       WHERE parked_at IS NOT NULL AND (
         (table_name = 'document' AND row_id = ?1)
         OR (table_name = 'meeting' AND row_id IN (SELECT id FROM meeting WHERE document_id = ?1))
         OR (table_name = 'participant' AND row_id IN (
           SELECT p.id FROM participant p JOIN meeting m ON m.id = p.meeting_id WHERE m.document_id = ?1))
         OR (table_name = 'transcript_segment' AND row_id IN (
           SELECT t.id FROM transcript_segment t JOIN meeting m ON m.id = t.meeting_id WHERE m.document_id = ?1)))`,
      documentId,
    );
  }

  outbox(): OutboxEntry[] {
    return this.#all(
      'SELECT version, table_name, row_id, op, parked_at FROM outbox ORDER BY version',
    ).map(toEntry);
  }

  /**
   * Up to `limit` entries to push, parents first (so a child never reaches the server before its
   * parent, even across batches), each with its current row.
   */
  takePushBatch(limit: number, maxBytes = Infinity): SyncPushEntry[] {
    const rank = `CASE table_name ${OUTBOX_TABLES.map((t) => `WHEN '${t}' THEN ${TABLE_RANK[t]}`).join(' ')} END`;
    const entries = this.#all(
      `SELECT version, table_name, row_id, op, parked_at FROM outbox WHERE parked_at IS NULL
       ORDER BY ${rank}, version LIMIT ?`,
      limit,
    ).map(toEntry);
    const batch: SyncPushEntry[] = [];
    const vanished: number[] = [];
    let bytes = 0;
    for (const e of entries) {
      const entry: SyncPushEntry | undefined =
        e.op === 'delete'
          ? { version: e.version, op: 'delete', table: e.table, id: e.rowId }
          : this.#pushEntry(e);
      if (!entry) {
        vanished.push(e.version);
        continue;
      }
      const size = JSON.stringify(entry).length + 1;
      // Always at least one entry: an oversized one goes alone (and is parked if the server refuses it).
      if (batch.length > 0 && bytes + size > maxBytes) break;
      batch.push(entry);
      bytes += size;
    }
    for (const v of vanished) this.#run('DELETE FROM outbox WHERE version = ?', v);
    return batch;
  }

  #pushEntry(e: OutboxEntry): SyncPushEntry | undefined {
    switch (e.table) {
      case 'document': {
        const d = this.document(e.rowId);
        return (
          d && {
            version: e.version,
            op: 'upsert',
            table: 'document',
            baseVersion: d.version,
            row: {
              id: d.id,
              workspaceId: d.workspaceId,
              kind: d.kind,
              title: d.title,
              contentJson: d.contentJson,
            },
          }
        );
      }
      case 'meeting': {
        const m = this.meeting(e.rowId);
        if (!m) return undefined;
        const { templateId: _t, ...row } = m;
        return { version: e.version, op: 'upsert', table: 'meeting', row };
      }
      case 'participant': {
        const r = this.#get('SELECT * FROM participant WHERE id = ?', e.rowId);
        return (
          r && { version: e.version, op: 'upsert', table: 'participant', row: toParticipant(r) }
        );
      }
      case 'transcript_segment': {
        const r = this.#get('SELECT * FROM transcript_segment WHERE id = ?', e.rowId);
        if (!r) return undefined;
        const s = toSegment(r);
        return { version: e.version, op: 'upsert', table: 'transcript_segment', row: s };
      }
    }
  }

  /** Applies the server's answer to a push (one transaction). */
  applyPushResults(
    sent: readonly SyncPushEntry[],
    results: readonly SyncPushResult[],
  ): PushOutcome {
    const byVersion = new Map(sent.map((e) => [e.version, e]));
    const outcome: PushOutcome = { acknowledged: 0, conflicts: 0, rejected: 0, copies: [] };
    this.transaction(() => {
      for (const result of results) {
        const entry = byVersion.get(result.version);
        if (!entry) continue; // not ours (or answered twice)
        byVersion.delete(result.version);
        const id = entry.op === 'delete' ? entry.id : entry.row.id;
        if (result.status === 'ok') {
          this.#run('DELETE FROM outbox WHERE version = ?', result.version);
          outcome.acknowledged += 1;
          if (entry.table === 'document' && result.row) this.#acceptDocument(result.row);
        } else if (result.status === 'conflict') {
          outcome.conflicts += 1;
          const copy = this.#resolveConflict(id, result.row);
          if (copy) outcome.copies.push(copy);
        } else {
          // Kept, not dropped (D-28): a trashed note can be restored, access can come back, a bug fixed.
          outcome.rejected += 1;
          this.park([result.version], `${entry.table} ${id}: ${result.code}: ${result.message}`);
        }
      }
    });
    return outcome;
  }

  /** After an acknowledged document push: take the server's version (and its row, unless edited since). */
  #acceptDocument(row: SyncDocumentRow): void {
    const pending = this.#get(
      "SELECT 1 FROM outbox WHERE table_name = 'document' AND row_id = ?",
      row.id,
    );
    this.#remote(() => {
      if (pending) this.#run('UPDATE document SET version = ? WHERE id = ?', row.version, row.id);
      else this.#upsertDocument(row);
    });
  }

  /**
   * D-19: the server copy wins the row; if our text differs, it survives as a new "conflicted copy" page
   * (which is pushed like any new document). Every pending entry of the row goes: they were based on the
   * losing text.
   */
  #resolveConflict(id: string, server: SyncDocumentRow): string | null {
    const local = this.document(id);
    let copy: string | null = null;
    if (
      local &&
      (local.title !== server.title || !sameDocumentContent(local.contentJson, server.contentJson))
    ) {
      copy = this.#newId();
      const at = this.#iso();
      this.#run(
        `INSERT INTO document (id, workspace_id, owner_id, kind, title, content_json, visibility, version, created_at, updated_at)
         VALUES (?, ?, ?, 'page', ?, ?, 'private', 0, ?, ?)`,
        copy,
        local.workspaceId,
        local.ownerId,
        `${local.title || 'Untitled'} (conflicted copy)`.slice(0, 1000),
        JSON.stringify(local.contentJson),
        at,
        at,
      );
      this.#log?.warn(`local-store: document ${id} changed elsewhere; kept ours as ${copy}`);
    }
    this.#run("DELETE FROM outbox WHERE table_name = 'document' AND row_id = ?", id);
    this.#remote(() => this.#upsertDocument(server));
    return copy;
  }

  // --- pull ------------------------------------------------------------------------------------------------

  /** Where the next pull starts. A pull scope older than the protocol's restarts from the beginning. */
  pullCursor(): string | null {
    if (this.getState(STATE.scope) !== String(SYNC_PULL_SCOPE)) {
      this.transaction(() => {
        this.setState(STATE.cursor, null);
        this.setState(STATE.scope, String(SYNC_PULL_SCOPE));
      });
      return null;
    }
    return this.getState(STATE.cursor);
  }

  resetPullCursor(): void {
    this.setState(STATE.cursor, null);
  }

  /**
   * Applies one pull page (requested with `sentCursor`). Returns `restart: true` when the user joined a
   * workspace since the last pull: nothing of the page is applied, the cursor is reset, pull again.
   */
  applyPull(page: SyncPullResponse, sentCursor: string | null): { restart: boolean } {
    const known = new Set<string>(JSON.parse(this.getState(STATE.workspaces) ?? '[]') as string[]);
    const current = new Set(page.workspaceIds);
    const joined = page.workspaceIds.some((id) => !known.has(id));
    return this.#remote(() => {
      this.#dropWorkspacesExcept(current);
      this.setState(STATE.workspaces, JSON.stringify([...current].sort()));
      if (joined && sentCursor !== null) {
        this.setState(STATE.cursor, null);
        return { restart: true };
      }
      this.#db.exec('PRAGMA defer_foreign_keys = ON');
      for (const change of page.changes) {
        const pending = this.#get(
          'SELECT 1 FROM outbox WHERE table_name = ? AND row_id = ?',
          change.table,
          change.op === 'delete' ? change.id : change.row.id,
        );
        if (!PULL_TABLES.has(change.table)) continue;
        if (change.op === 'delete') {
          if (change.table === 'workspace') this.#dropWorkspace(change.id);
          else this.#run(`DELETE FROM ${change.table} WHERE id = ?`, change.id);
          this.#run(
            'DELETE FROM outbox WHERE table_name = ? AND row_id = ?',
            change.table,
            change.id,
          );
          continue;
        }
        // The note changed on the server (e.g. restored from the trash): retry what was parked for it.
        // An echo of our own acknowledged write (same version), or a note going *to* the trash, doesn't.
        if (change.table === 'document') {
          const local = this.document(change.row.id);
          if (
            change.row.deletedAt === null &&
            (!local || local.version !== change.row.version || local.deletedAt !== null)
          ) {
            this.unparkDocument(change.row.id);
          }
        }
        if (pending) continue; // our edit is pushed next; the server resolves it
        switch (change.table) {
          case 'workspace':
            if (current.has(change.row.id)) this.#upsertWorkspace(change.row);
            break;
          case 'document':
            this.#upsertDocument(change.row);
            break;
          case 'meeting':
            this.#upsertMeeting(change.row);
            break;
          case 'participant':
            this.#upsertParticipant(change.row);
            break;
          case 'transcript_segment':
            this.#upsertSegment(change.row);
            break;
        }
      }
      this.#dropOrphans();
      // Pending upserts whose rows a remote delete (or its cascade) took away can't be pushed.
      for (const t of OUTBOX_TABLES) {
        this.#run(
          `DELETE FROM outbox WHERE table_name = '${t}' AND op = 'upsert' AND row_id NOT IN (SELECT id FROM ${t})`,
        );
      }
      this.setState(STATE.cursor, page.cursor);
      this.setState(STATE.scope, String(SYNC_PULL_SCOPE));
      return { restart: false };
    });
  }

  #dropWorkspace(id: string): void {
    this.#run('DELETE FROM document WHERE workspace_id = ?', id);
    this.#run('DELETE FROM workspace WHERE id = ?', id);
  }

  #dropWorkspacesExcept(keep: ReadonlySet<string>): void {
    const ids = new Set([
      ...this.#all('SELECT id FROM workspace').map((r) => String(r.id)),
      ...this.#all('SELECT DISTINCT workspace_id AS id FROM document').map((r) => String(r.id)),
    ]);
    for (const id of ids) if (!keep.has(id)) this.#dropWorkspace(id);
  }

  /** Rows whose parent never arrived (e.g. not readable): dropped before commit, repeatedly. */
  #dropOrphans(): void {
    for (let round = 0; round < 10; round++) {
      const bad = this.#all('PRAGMA foreign_key_check') as { table: string; rowid: number }[];
      if (bad.length === 0) return;
      for (const { table, rowid } of bad) {
        this.#log?.warn(`local-store: dropping ${table} row without its parent`);
        this.#run(`DELETE FROM "${table.replace(/"/g, '')}" WHERE rowid = ?`, rowid);
      }
    }
  }

  #upsertWorkspace(w: SyncWorkspaceRow): void {
    this.#run(
      `INSERT INTO workspace (id, name, kind) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
      w.id,
      w.name,
      w.kind,
    );
  }

  #upsertDocument(d: SyncDocumentRow): void {
    this.#run(
      `INSERT INTO document (id, workspace_id, folder_id, owner_id, kind, title, content_json, visibility, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET workspace_id = excluded.workspace_id, folder_id = excluded.folder_id,
         owner_id = excluded.owner_id, kind = excluded.kind, title = excluded.title,
         content_json = excluded.content_json, visibility = excluded.visibility, version = excluded.version,
         created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
      d.id,
      d.workspaceId,
      d.folderId,
      d.ownerId,
      d.kind,
      d.title,
      JSON.stringify(d.contentJson),
      d.visibility,
      d.version,
      d.createdAt,
      d.updatedAt,
      d.deletedAt,
    );
  }

  #upsertMeeting(m: SyncMeetingRow): void {
    this.#run(
      `INSERT INTO meeting (id, document_id, calendar_event_id, started_at, ended_at, platform, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET document_id = excluded.document_id,
         calendar_event_id = excluded.calendar_event_id, started_at = excluded.started_at,
         ended_at = excluded.ended_at, platform = excluded.platform, template_id = excluded.template_id`,
      m.id,
      m.documentId,
      m.calendarEventId,
      m.startedAt,
      m.endedAt,
      m.platform,
      m.templateId,
    );
  }

  #upsertParticipant(p: SyncParticipantRow): void {
    this.#run(
      `INSERT INTO participant (id, meeting_id, name, email, source) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET meeting_id = excluded.meeting_id, name = excluded.name,
         email = excluded.email, source = excluded.source`,
      p.id,
      p.meetingId,
      p.name,
      p.email,
      p.source,
    );
  }

  #upsertSegment(s: SyncSegmentRow): void {
    this.#run(
      `INSERT INTO transcript_segment (id, meeting_id, source, speaker_label, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET meeting_id = excluded.meeting_id, source = excluded.source,
         speaker_label = excluded.speaker_label, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
         text = excluded.text`,
      s.id,
      s.meetingId,
      s.source,
      s.speakerLabel,
      s.startMs,
      s.endMs,
      s.text,
    );
  }
}

// --- row mapping --------------------------------------------------------------------------------------------

const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v));

function toEntry(r: Row): OutboxEntry {
  return {
    version: Number(r.version),
    table: r.table_name as OutboxTable,
    rowId: String(r.row_id),
    op: r.op as 'upsert' | 'delete',
    parked: r.parked_at !== null && r.parked_at !== undefined,
  };
}

function toDocument(r: Row): LocalDocument {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    folderId: str(r.folder_id),
    ownerId: String(r.owner_id),
    kind: r.kind as DocumentKind,
    title: String(r.title),
    contentJson: JSON.parse(String(r.content_json)) as LocalDocument['contentJson'],
    visibility: r.visibility as DocumentVisibility,
    version: Number(r.version),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    deletedAt: str(r.deleted_at),
  };
}

function toMeeting(r: Row): LocalMeeting {
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    calendarEventId: str(r.calendar_event_id),
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
    platform: str(r.platform),
    templateId: str(r.template_id),
  };
}

function toParticipant(r: Row): LocalParticipant {
  return {
    id: String(r.id),
    meetingId: String(r.meeting_id),
    name: String(r.name),
    email: str(r.email),
    source: r.source as LocalParticipant['source'],
  };
}

function toSegment(r: Row): LocalSegment {
  return {
    id: String(r.id),
    meetingId: String(r.meeting_id),
    source: r.source as TranscriptSource,
    speakerLabel: str(r.speaker_label),
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    text: String(r.text),
  };
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
