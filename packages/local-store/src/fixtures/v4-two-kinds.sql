-- A desktop local store at schema version 4 — the last one with `workspace.kind` (before D-36) — as an
-- upgraded app finds it on disk. Loaded by `migration-5.test.ts` into a database built from migrations 1–4.
--
-- Pulled from the server (no outbox entries): the user's workspaces of both former kinds, a synced meeting
-- note with its transcript, and a teammate's note.
UPDATE sync_control SET applying_remote = 1 WHERE id = 1;

INSERT INTO workspace (id, name, kind, role) VALUES
  ('ws-own', 'Personal', 'personal', 'owner'),
  ('ws-acme', 'Acme', 'team', 'member'),
  ('ws-board', 'Board', 'team', 'viewer');

INSERT INTO document (id, workspace_id, owner_id, kind, title, content_json, visibility, version, created_at, updated_at) VALUES
  ('doc-synced', 'ws-own', 'u1', 'meeting', 'Synced standup',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"pelican budget notes"}]}]}',
   'private', 3, '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z'),
  ('doc-acme', 'ws-acme', 'u2', 'meeting', 'Acme weekly',
   '{"type":"doc","content":[{"type":"paragraph"}]}',
   'workspace', 1, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z');

INSERT INTO meeting (id, document_id, calendar_event_id, started_at, ended_at) VALUES
  ('m-synced', 'doc-synced', 'gcal:abc', '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z'),
  ('m-acme', 'doc-acme', NULL, '2026-11-02T10:00:00.000Z', '2026-11-02T10:30:00.000Z');

INSERT INTO participant (id, meeting_id, name, email, source) VALUES
  ('p-1', 'm-synced', 'Ada Lovelace', 'ada@example.test', 'calendar');

INSERT INTO transcript_segment (id, meeting_id, source, speaker_label, start_ms, end_ms, text) VALUES
  ('seg-1', 'm-synced', 'mic', NULL, 0, 1200, 'Morning, quick round on the pelican budget.'),
  ('seg-2', 'm-synced', 'system', NULL, 1500, 4000, 'I finished the export flow yesterday.');

UPDATE sync_control SET applying_remote = 0 WHERE id = 1;

-- Recorded offline and not pushed yet: these rows sit in the outbox and exist nowhere else.
INSERT INTO document (id, workspace_id, owner_id, kind, title, visibility, version, created_at, updated_at) VALUES
  ('doc-offline', 'ws-own', 'u1', 'meeting', 'Offline recording', 'private', 0,
   '2026-11-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z');
INSERT INTO meeting (id, document_id, started_at) VALUES
  ('m-offline', 'doc-offline', '2026-11-20T09:00:00.000Z');
INSERT INTO transcript_segment (id, meeting_id, source, start_ms, end_ms, text) VALUES
  ('seg-offline', 'm-offline', 'system', 0, 2000, 'This was said while offline.');

-- Where sync is, and what the user chose on this Mac.
INSERT INTO sync_state (key, value) VALUES
  ('pull.cursor', 'cursor-42'),
  ('pull.scope', '3'),
  ('pull.workspaces', '["ws-acme","ws-board","ws-own"]'),
  ('desktop.activeWorkspace', 'ws-own');
