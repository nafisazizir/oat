/**
 * Local schema migrations, applied in order; the schema version is `PRAGMA user_version` (= number of
 * migrations applied). Append only: a released migration is never edited. A database whose version is
 * newer than this list (written by a newer app), or on which a migration fails, is wiped and rebuilt from
 * the server (D-19: the local database is a disposable cache).
 *
 * Synced tables mirror the server (SPEC §6) with text ids, ISO-8601 timestamps and JSON as text. Each one
 * has three triggers that enqueue `(table, id, op)` into `outbox` with a fresh, monotonically increasing
 * `version` (AUTOINCREMENT never reuses a value), unless `sync_control.applying_remote` is set (changes
 * coming from the server must not echo back). `INSERT OR REPLACE` keeps one entry per row: a newer edit
 * replaces the older entry with a higher version, so an acknowledgement for the older version can never
 * clear it.
 */

/** Tables whose local writes are pushed, in the order parents come before children. */
export const OUTBOX_TABLES = ['document', 'meeting', 'participant', 'transcript_segment'] as const;

const now = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/** The plain text of a TipTap JSON body (every text node, in order), for the search index. */
const DOC_BODY = (row: string) =>
  `(SELECT coalesce(group_concat(value, ' '), '') FROM json_tree(${row}.content_json) WHERE key = 'text' AND type = 'text')`;

function outboxTriggers(table: string): string {
  const enqueue = (row: 'NEW' | 'OLD', op: 'upsert' | 'delete') => `
    INSERT OR REPLACE INTO outbox (table_name, row_id, op, first_enqueued_at)
    VALUES ('${table}', ${row}.id, '${op}', COALESCE(
      (SELECT first_enqueued_at FROM outbox WHERE table_name = '${table}' AND row_id = ${row}.id), ${now}));`;
  const when = `WHEN (SELECT applying_remote FROM sync_control WHERE id = 1) = 0`;
  return `
CREATE TRIGGER ${table}_outbox_insert AFTER INSERT ON ${table} ${when}
BEGIN ${enqueue('NEW', 'upsert')} END;
CREATE TRIGGER ${table}_outbox_update AFTER UPDATE ON ${table} ${when}
BEGIN ${enqueue('NEW', 'upsert')} END;
CREATE TRIGGER ${table}_outbox_delete AFTER DELETE ON ${table} ${when}
BEGIN ${enqueue('OLD', 'delete')} END;`;
}

export const MIGRATIONS: readonly string[] = [
  // 1 — 2.6: first synced slice (workspaces, meeting documents, transcripts).
  `
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE sync_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  applying_remote INTEGER NOT NULL DEFAULT 0 CHECK (applying_remote IN (0, 1))
) STRICT;
INSERT INTO sync_control (id, applying_remote) VALUES (1, 0);

CREATE TABLE outbox (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  first_enqueued_at INTEGER NOT NULL,
  -- Set when the entry can't be sent as is (server rejected it, or it alone breaks a push): skipped by
  -- pushes, shown in the sync status, retried later. A new edit of the row replaces the entry (unparked).
  parked_at INTEGER,
  park_reason TEXT,
  UNIQUE (table_name, row_id)
);

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team'))
) STRICT;

CREATE TABLE document (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  folder_id TEXT,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('meeting', 'page')),
  title TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace', 'link')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX document_workspace_idx ON document (workspace_id);

CREATE TABLE meeting (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE REFERENCES document (id) ON DELETE CASCADE,
  calendar_event_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  platform TEXT,
  template_id TEXT
) STRICT;

CREATE TABLE participant (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  source TEXT NOT NULL CHECK (source IN ('calendar', 'manual'))
) STRICT;
CREATE INDEX participant_meeting_idx ON participant (meeting_id);

CREATE TABLE transcript_segment (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meeting (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
  speaker_label TEXT,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text TEXT NOT NULL
) STRICT;
CREATE INDEX transcript_segment_meeting_start_idx ON transcript_segment (meeting_id, start_ms);

${OUTBOX_TABLES.map(outboxTriggers).join('\n')}
`,
  // 2 — 3.5: conflicted copies, lost-ack hashes, subtree backfill queue, local full-text search.
  `
ALTER TABLE document ADD COLUMN conflict_of_id TEXT;
ALTER TABLE document ADD COLUMN conflict_device TEXT;
ALTER TABLE document ADD COLUMN conflict_at TEXT;
CREATE INDEX document_conflict_of_idx ON document (conflict_of_id) WHERE conflict_of_id IS NOT NULL;

-- What this device pushed for a document since the server last acknowledged one of its writes: hashes of
-- title + canonical body. A 409 whose server copy matches one is our own write whose ack was lost.
CREATE TABLE doc_sent (
  document_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, hash)
) STRICT;

-- Meeting documents seen for the first time after the initial sync: their subtree (meeting, participants,
-- segments) is fetched with GET /api/sync/backfill; \`after\` is the next page token.
CREATE TABLE backfill (
  document_id TEXT PRIMARY KEY,
  after TEXT,
  queued_at INTEGER NOT NULL,
  -- Failed fetches (server errors, refusals); dropped after a few: backfill is best-effort.
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Local full-text search (FTS5, trigram: substring matches in any language, accents folded), kept by
-- triggers. Index rowids are the base tables' rowids: never VACUUM this file (it may renumber them).
CREATE VIRTUAL TABLE document_fts USING fts5(title, body, tokenize = 'trigram remove_diacritics 1');
CREATE VIRTUAL TABLE segment_fts USING fts5(text, tokenize = 'trigram remove_diacritics 1');

CREATE TRIGGER document_fts_insert AFTER INSERT ON document BEGIN
  INSERT INTO document_fts (rowid, title, body) VALUES (NEW.rowid, NEW.title, ${DOC_BODY('NEW')});
END;
CREATE TRIGGER document_fts_update AFTER UPDATE OF title, content_json ON document BEGIN
  DELETE FROM document_fts WHERE rowid = OLD.rowid;
  INSERT INTO document_fts (rowid, title, body) VALUES (NEW.rowid, NEW.title, ${DOC_BODY('NEW')});
END;
CREATE TRIGGER document_fts_delete AFTER DELETE ON document BEGIN
  DELETE FROM document_fts WHERE rowid = OLD.rowid;
END;
CREATE TRIGGER segment_fts_insert AFTER INSERT ON transcript_segment BEGIN
  INSERT INTO segment_fts (rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER segment_fts_update AFTER UPDATE OF text ON transcript_segment BEGIN
  DELETE FROM segment_fts WHERE rowid = OLD.rowid;
  INSERT INTO segment_fts (rowid, text) VALUES (NEW.rowid, NEW.text);
END;
CREATE TRIGGER segment_fts_delete AFTER DELETE ON transcript_segment BEGIN
  DELETE FROM segment_fts WHERE rowid = OLD.rowid;
END;

INSERT INTO document_fts (rowid, title, body) SELECT rowid, title, ${DOC_BODY('document')} FROM document;
INSERT INTO segment_fts (rowid, text) SELECT rowid, text FROM transcript_segment;
`,
  // 3 — 2.7: segments filled in from the audio archive after an STT outage (local only, not synced).
  `
ALTER TABLE transcript_segment ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1));
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * The audio index (`audio-index.sqlite`, D-24/D-28): `audio_recording` rows — local only, never synced and
 * **never wiped** (they can't be rebuilt: parts and offsets), so they live outside the disposable cache.
 */
export const AUDIO_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE audio_recording (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
  part INTEGER NOT NULL,
  offset_ms REAL NOT NULL,
  path TEXT NOT NULL,
  codec TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  started_at REAL NOT NULL,
  duration_ms REAL NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recording', 'complete', 'partial', 'failed', 'deleted'))
) STRICT;
CREATE INDEX audio_recording_meeting_idx ON audio_recording (meeting_id);
`,
  // D-30: the account that recorded each row. Existing rows stay NULL ("unknown") until the account whose
  // local database owns the meeting claims them (desktop `AudioStorage`).
  `
ALTER TABLE audio_recording ADD COLUMN user_id TEXT;
CREATE INDEX audio_recording_user_idx ON audio_recording (user_id);
`,
  // 2.7: transcript back-fill jobs (STT outages re-transcribed from the archive) and crash recoveries. Here,
  // not in the per-user cache: they refer to audio on this Mac and must survive a cache rebuild.
  `
CREATE TABLE stt_backfill (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  user_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
  -- Meeting clock (ms). done_ms: everything before it has been transcribed (chunk cursor).
  start_ms REAL NOT NULL,
  end_ms REAL NOT NULL CHECK (end_ms >= start_ms),
  done_ms REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at REAL NOT NULL DEFAULT 0,
  segments INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
) STRICT;
CREATE INDEX stt_backfill_meeting_idx ON stt_backfill (meeting_id);
CREATE INDEX stt_backfill_status_idx ON stt_backfill (status);

CREATE TABLE recording_recovery (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  user_id TEXT,
  recovered_at REAL NOT NULL,
  -- Wall clock (Unix ms) the repaired audio reaches.
  saved_until REAL NOT NULL,
  -- JSON [{source, part, offsetMs, endMs, startedAt}] of the repaired parts.
  parts TEXT NOT NULL,
  -- When the meeting was closed and its tail queued for back-fill (needs that account's database open).
  applied_at REAL
) STRICT;
CREATE INDEX recording_recovery_meeting_idx ON recording_recovery (meeting_id);
`,
];
