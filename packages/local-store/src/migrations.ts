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
];
