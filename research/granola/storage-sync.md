# Granola desktop: local storage and sync model (task 0.5)

Question: what is Granola's local storage and sync model? Covers the local DB schema at structural level,
on-disk caches/files, how documents/transcripts sync with the server, offline queueing, conflict handling,
and what syncs versus what stays local.

Target: `/Applications/Granola.app`, `@granola/desktop` 7.786.3, 2026-11-14. Static reading of the JS already
extracted to `research/granola/raw/asar/` (from tasks 0.2/0.3). Nothing was executed against Granola, no
network, no user data. **The on-disk DB was not opened and its key was not looked for.** The schema below comes
from replaying the migration list shipped in the renderer bundle into a throwaway in-memory SQLite (no Granola
data involved) and listing tables/columns. All wording is ours. No DDL, prompts or code are reproduced.

Confidence: **confirmed** = read directly in shipped code · **inferred** = strong structural reading, not
observed end to end · **unknown** = not established.

## Evidence index

Offsets are character offsets into the extracted files (paths relative to `research/granola/raw/asar/`).
Minified names are build-specific. No new REA session was opened for this task; the asar was already
inventoried by REA in task 0.2 (`ev_260dd3ae440de3d9a688c0b8bbff3bc287a0d311b2a2ba6ac557e092e2c84ea1`) and
0.3 (`ev_bc8f805b7b779ab969ca2008993bcbfcab7adcb678d8f067094a8763863ac03c`). Everything here is a structural
reading of those extracted files.

| ID | Location | What it shows |
|---|---|---|
| S1 | `dist-electron/sqlite_process/index.js` | storage utility process: 1 writer + 4 read-only worker threads, key comes from main by message, no key means an in-memory "ephemeral" DB, open/ensureOpen/clear protocol, table-change fan-out to every connected renderer port |
| S2 | `dist-electron/sqlite_process/worker.js` | `better-sqlite3-multiple-ciphers` in SQLCipher (v4-compatible) mode, WAL + normal sync on the writer, read-only connections use query-only; SQLite update hook batches changed table names per microtask; if opening fails the files (db, -wal, -shm) are deleted and recreated; file is `<name>.db` in userData |
| S3 | `dist-app/assets/getAPIEndpointInWindow-BbNN8SUj.js` @~28100–90900 | ordered list of 54 SQL migrations (drizzle-kit style output) + runner: schema version kept in a one-row `system` table; DB newer than app → wipe and rebuild; migration failure → wipe and retry once; init under a Web Lock; DB name `granola` |
| S4 | same file @~77000–86000 | `sync_outbox` / `sync_state` tables and per-table triggers, with SQL comments explaining the design (paraphrased below) |
| S5 | `dist-app/assets/useBriefEmailConnector-CY5Ao1eC.js` @~13400–16500 | "collection" sync engine: push outbox, paginated pull with a sync token, triggers, backoff |
| S6 | `dist-app/assets/api-Ce100vjw.js` @237280 (request helper), @~239209 (document endpoints), @~224763 (collection schemas), @~265909 (`sync-push`, `sync-push-v2`, `sync-pull`) | RPC-style POST API; named serial request queues; retry backoff; server-clock sampling; synced collection enum |
| S7 | `dist-electron/main/index.js` @~1086000–1090500 (encrypted JSON store + cache module), @551569–580000 (cache reducer), @~2407587 (DB size probe), @~2534704 (legacy file cleanup) | main-owned app-state "cache" persisted as an encrypted JSON file; reducer actions for transcripts, sync operations, entities |
| S8 | `dist-app/assets/cacheStore-C4J8vVuo.js` @~990500–1003500, @~456500–463500, @90977 | renderer side of the cache (optimistic apply + rebase), enqueueing sync operations, document/panel SQLite writes, SQLite-backed Yjs persistence, Yjs merge-result enum |
| S9 | `dist-app/assets/formatKeys-BCbAL9FC.js` @~16000–18300 | entity pull: list (id, updated_at) per type, fetch newer in batches of 50, LWW, protect pending local ops |
| S10 | `dist-app/assets/useCollapsiblePanel-C_y4lCvU.js` @~4300 | entity registry: common envelope (id, workspace_id, created/updated/deleted timestamps), per-type `localOnly` and feature-flag gating |
| S11 | `dist-app/assets/primary-CvQXJiuH.js` @~6253500–6266500 (user WebSocket), @~6266000–6271000 (operation pusher), @~6235782 (periodic entity sync), @~6812939 (per-document metadata room), @~562829 (durable summary resume) | realtime notification channel and push loop |
| S12 | `dist-app/assets/winWebcamRuntimeProbe-WGYbxx14.js` @~97000–110000 | document full/partial sync: server "document set" diff, batched fetch, whole-document upsert push, 403/409 handling, 30-day soft-delete window, panel reconcile, Yjs resolution |
| S13 | `dist-app/assets/gatherPromptInputsForDocument-zGAIDC81.js` @~183000–192000 | Yjs collaboration provider (y-partyserver "YProvider" over PartyKit WebSocket + BroadcastChannel), local Yjs cache manager, owner seeding from JSON |
| S14 | `dist-app/assets/events-DhQYs4JX.js` @~2500 | transcript uploader: periodic, uploads only chunk ids marked unsynced, skips off-record ranges, applies server redactions |
| S15 | `dist-app/assets/cache-kv2l_fkS.js` @~161076, @~162185 | renderer reducer copy: "remove synced chunks" compares content; prune rules for completed ops / old queued events |

## 1. The big picture

Granola does **not** have one sync system. It has five, layered by data type:

```
                          ┌───────────────────────── server (RPC over HTTPS POST) ─────────────────────────┐
                          │  document endpoints   entity sync-push   collection sync-push/pull   transcripts │
                          └───▲────────▲──────────────▲─────────────────────▲──────────────────▲────────────┘
     user WebSocket (PartySocket) "something changed" hints: run_sync{entities}, sync{collection}, … + seq/replay
                              │        │              │                     │                  │
 ┌────────── renderer (primary window) ────────────────────────────────────────────────────────────────────┐
 │ (A) documents + panels      (B) entities          (C) collections        (D) transcripts   (E) note body  │
 │  diff-by-updated_at,        op log, LWW pull,      SQLite outbox via      append chunks,    Yjs doc via   │
 │  whole-row upsert           batched push           triggers, sync token   upload unsynced   PartyKit room │
 │        │                         │                      │                     │                  │       │
 │        ▼                         ▼                      ▼                     ▼                  ▼       │
 │  SQLite (granola.db, SQLCipher)  main "cache" JSON    SQLite                 main "cache" JSON  SQLite    │
 │  documents, document_panels,     (entities map,       dictation_* tables,    (transcripts map,  ydocs     │
 │  FTS, tags, attendees, …         sync_operations_log) sync_outbox/state      unsynced ids)      table     │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- No ElectricSQL shapes. The Electric code in the bundle is its **Durable Streams** client, used to resume
  streaming AI summary generation after a drop, not for table sync. **confirmed** presence (S6 @~27652) +
  **inferred** use (S11 @~562829 "durable-summary" resume flow).
- No CRDT for metadata. Yjs is used **only for rich-text bodies** (private notes, AI summary panels).
  Everything else is timestamp LWW. **confirmed** (S8, S12, S13)
- The realtime WebSocket carries **invalidation hints, not data**. The client then pulls over HTTP. **confirmed** (S11)

## 2. Local storage on disk

All under the Electron userData directory. **confirmed** unless marked.

| File / store | Format | Holds | Evidence |
|---|---|---|---|
| `granola.db` (+ `-wal`, `-shm`) | SQLite, SQLCipher-encrypted, WAL | documents, AI panels, calendar events, briefs, dictation, Yjs updates, FTS indexes, sync bookkeeping (schema in §3) | S1, S2, S3, S7 @~2407587 |
| `cache-v6.json.enc` | JSON, encrypted with a data-encryption key (DEK), streamed to a temp file then renamed; writes throttled (default 10 s) with a 2 s cooldown | the main-process app-state "cache": preferences/UI state, feature flags, **transcripts per document**, unsynced transcript chunk ids, **entity store + sync operation log**, pending audit events / document views, last-sync timestamps, websocket seq + processed message ids | S7 |
| `stored-accounts.json` (encrypted store) | same encrypted-JSON helper | saved accounts for account switching | S7 @~1189316 |
| `local-state.json`, `user-preferences.json`, `window-state.json`, misc small JSON | plain JSON | flags/preferences that must load before the encrypted store, window geometry, etc. | S7 (file-name list) |
| renderer `localStorage` | browser storage | small in-flight markers, e.g. a pending AI-summary attempt so generation can resume after a crash (short expiry, ~14 min; time unit inferred) | S11 @~562829 |
| legacy IndexedDB (`notes:*`, `summary:*`) | y-indexeddb style | **old** Yjs persistence; now migrated to the SQLite `ydocs` table and deleted on cleanup | S8 @~461700 |
| debug WAVs, voice-fingerprint files, logs | files | see `audio-path.md` (debug recording off by default) | audio-path.md |

Notes:
- Old cache formats (`cache-v3`…`cache-v6.json` plaintext, `supabase.json`) are deleted at startup, so the
  move to encrypted-at-rest was a migration. **confirmed** (S7 @~2534704)
- A corrupt or undecryptable `cache-v6.json.enc` is **deleted and the app starts with an empty cache**; a DB
  that fails to open is deleted and recreated; a DB written by a newer app version is wiped. Local state is
  treated as a disposable, rebuildable cache of the server. **confirmed** (S2, S3, S7)
- In the web build, the same SQL layer runs on wa-sqlite over OPFS instead of the storage process (one
  interface, two backends). **confirmed** (S8 @~456500: backend picked by `isWebShell`)
- Query builder is Kysely-style (`selectFrom(...).compile()`); migrations look like drizzle-kit output.
  **inferred** (library identity)

### Storage process design (S1, S2) — confirmed
- One **writer** connection and a **pool of 4 read-only** connections, each on its own worker thread inside
  the storage utility process. Reads go to a free reader (queued if all busy); writes are serialised on the writer.
- Batches run in one transaction and report which statement failed.
- The writer installs an **update hook**; changed table names are coalesced per tick and pushed as a
  `change` message to every renderer port. The renderer's `liveQuery` re-runs queries that touch those tables.
  This is how the UI stays reactive to sync writes without polling.
- The renderer reaches the process through a dedicated MessagePort (no hop through main), see `bundle-map.md` §2.

## 3. Local DB schema (structure only)

Derived from replaying the 54 shipped migrations (S3). Column names are listed as concepts; types simplified.

**Bookkeeping**
- `system`: one row, schema version (= number of applied migrations).
- `sync_state`: per collection: opaque server sync token, and an "applying remote changes" flag.
- `sync_outbox`: autoincrement version (PK), collection, row id, deleted flag, enqueued-at. Unique on
  (collection, id).

**Documents (one per meeting / note)**
- `documents`: text UUID id; created/updated/deleted timestamps; title; owner user id; workspace id; type and
  creation source; flags (transcribe on/off, privacy mode, public, shareable link, scratchpad, primary event
  note, trashed, valid meeting); visibility and link visibility; **notes in three forms** (rich-text JSON,
  plain text, Markdown); **Yjs state + Yjs schema version** for the notes; JSON blobs for calendar event,
  people/attendees, chapters, summary, attachments, attached links, metadata, transcription metadata,
  notification config, integration shares, tags; overview text; selected template; audio file handle and
  external transcription id; transcript-deleted-at; sharing role/flags (is shared, shared directly, has
  direct shares, user opened via link, document user role); last indexed-at; a meeting-end counter; several
  CRM/integration markers.
  Indexes target the note list: by display time (not deleted / trashed / shared variants), event id,
  recurring event id, event summary, folder (note list), workspace.
- `document_panels`: AI output tabs per document (summary etc.): id, document id, title, template slug,
  content JSON + original content JSON, created/updated/deleted/last-viewed timestamps, content-updated-at,
  generation started/failed timestamps (used as a small state machine: idle → generating → completed/failed,
  with a 3-minute staleness cut-off), suggested questions, generated lines, user feedback, speaker-attribution
  flag, **Yjs version**.
- `document_attendees` (email, document id) and `document_tags` (document id, category, value): **derived
  tables maintained by triggers** from the JSON columns on `documents`, so attendees/tags are queryable.
  Plus a view combining attendee sources.
- `speaker_name_suggestions`: per document + speaker identity: ordered suggestion JSON.
- FTS5 virtual tables (trigram tokenizer, case-insensitive): one over document title + plain notes, one over
  plain panel content. Local full-text search, no server round trip.

**Collaboration**
- `ydocs`: autoincrement id, doc id (string key = content type + Yjs schema version + content id), binary Yjs
  update, created-at. An **append-only update log** per doc (§5E).

**Other caches**
- `calendar_events`: id, start, end, full event JSON.
- `pre_meeting_briefs`: id, event id, document id, status/error, streamed chunks JSON, content, short
  brief, references, available connections, variant, high-signal / auto-opened flags, timestamps.
- `dictation_attempts`: id, timestamps, status, failure reason, language, audio/speech durations, word count,
  text, audio-expiry. **Synced** (§5C), only when the user opts in to dictation-history sync.
- `dictation_dictionary_terms`: id, timestamps, soft-delete, term, source, starred. **Synced**.
- `dictation_dictionary_term_usage`: id, use count, last used. **Deliberately local-only** (a migration
  comment says the usage stats are split out so they never leave the device).

What is **not** in SQLite: transcripts, chat threads/messages, folders/lists metadata and other "entities".
Those live in the main-process encrypted JSON cache (S7). **confirmed** (no such tables in S3; reducer actions in S7)

## 4. Server API shape (S6) — confirmed

- RPC style: every call is `POST <api-base>/<endpoint-name>` with a JSON body and bearer token, plus
  client-version, platform, device-id and active-workspace headers.
- **Named serial queues**: writes such as create/update document and create/update panel go through an
  in-memory per-name promise queue (`documents`, `document-panels`), so writes to the same area never race
  each other. Retries use a fixed backoff ladder (0, 1, 2, 4 … 256 s) and stop on 401/403/451.
- Each response's server-time header feeds an NTP-style clock-offset estimator (sliding window of 20
  samples, RTT under 10 s). **confirmed** estimator; what it is used for is **unknown** (likely timestamp
  correction for LWW, **inferred**).
- Some payloads have `*_encrypted` variants of notes / Yjs state in the API schema; meaning **unknown**
  (possibly server-side field encryption).

## 5. How each data type syncs

### A. Documents and AI panels — timestamp diff + whole-row upsert (S12) — confirmed

**Pull (full sync).** Triggered at start, periodically, on window focus, and when the WebSocket says
"documents changed" (debounced; skipped while the window is hidden unless urgent).
1. Read every local document's id, owner, updated-at, deleted-at, shared flag.
2. Ask the server for the **document set**: a map of id → {updated-at, owner/shared, has-notes-Yjs,
   has-panel-Yjs, …}.
3. For each server entry, fetch it if missing locally, if the server's updated-at is newer than
   max(local doc updated-at, latest panel updated-at), or if the server has Yjs state the device lacks.
   Own docs first, then others, then shared; fetched in batches with bounded concurrency, newest first.
   The first 25 are fetched before the rest so the list fills fast on a cold start.
4. Fetched rows are upserted into SQLite; the last-viewed panel and any Yjs states come along in the same
   payload and are stored into `ydocs`.

**Push.** In the same pass, for each **local** owned document:
- local updated-at newer than the server's, or not on the server at all → **upsert the whole document row**
  (including the current notes Yjs state) to the server.
- Server replies with a Yjs **resolution**: created / merged / overwritten / client-wins-disjoint /
  unchanged. For "client wins, disjoint" the client applies the server's returned state locally. **confirmed**
  enum; exact server semantics **inferred** (server merges the Yjs state rather than replacing it).
- 403 → user lost access, delete locally. 409 → server hard-deleted it, delete locally. 401 → leave it.

**Deletes.** Soft delete (`deleted_at`). Locally soft-deleted rows are kept for 30 days then removed; if a
deleted doc is missing from the server set it is treated as hard-deleted and removed. Docs owned by
someone else that drop out of the set are pruned (access revoked).

**Panels.** Compared per document by max(last-viewed, updated-at): local newer → push panel; remote newer
→ take it; panels mid-generation are left alone.

**Interactive edits** (outside the sync pass) write SQLite first with a fresh updated-at, then call
update-document / update-panel on the serial queue. If that call fails, the next full sync still pushes
it because local updated-at is newer. So the **"outbox" for documents is implicit**: SQLite rows + a
timestamp comparison, not a queue table. **inferred** from S8 + S12.

### B. Entities (chat threads/messages, MCP connections, folder rule suggestions, automations) — op log (S9, S10, S11)

- Every entity has the same envelope: UUID id, workspace id, created/updated/deleted timestamps, typed data.
  A registry marks types as `localOnly` (never synced) or behind a feature flag. **confirmed**
- **Local write**: the renderer applies an add/update/delete operation to the entity map and appends it to
  `sync_operations_log` in the main cache with a client-generated operation id and status
  `pending` (or `held`, released later). **confirmed** (S8 @~992170)
- **Push loop**: when the log changes, when online again, on window focus, and on an adaptive timer, it
  sends pending ops in batches (≤50 ops, ≤~4.5 MB; oversize ops are dropped with a log). Server returns a
  per-operation status: completed, or failed with a `retryable` flag. Retryable failures raise the backoff
  (5 s base, up to 2 min); non-retryable ones mark the op failed and run a per-type rollback hook.
  Completed ops are pruned after 24 h. **confirmed** (S11, S15)
- **Pull**: per type, list (id, updated-at) from the server, fetch newer ones in batches of 50, apply as
  updates **only if server updated-at is newer** (LWW per entity), add missing ones unless a local delete
  is pending, delete local ones the server no longer has unless a local add is pending. **confirmed** (S9)

### C. Collections (dictation history, custom dictionary) — trigger-driven SQLite outbox (S4, S5) — confirmed

This is the newest and cleanest design in the app, and the closest to what Oat wants:
- **Triggers enqueue**: after insert/update/delete on a synced table, a trigger upserts a row into
  `sync_outbox` (collection, id, deleted flag). Each enqueue takes a **new outbox version** but keeps the
  first enqueue time. An update trigger also stamps updated-at, except when remote changes are being applied.
- **Echo suppression**: while applying a pull, `sync_state.applying_remote` is set to 1 so triggers do not
  enqueue the server's own changes.
- **Local pending edits win over incoming remote inserts**: a before-insert trigger silently ignores a
  remote row if that id is still in the outbox.
- **Push** reads the outbox in version order (1000 at a time), joins current row values (deletes send only
  the id), caps request size at ~4 MB, posts `sync-push-v2`, and deletes the outbox entries **by version**.
  The comments explain why: an acknowledgement of an older edit must not delete the entry for a newer edit
  made in the meantime. The response has a single "rejected" flag; if set, a pull follows.
- **Pull** posts `sync-pull` with the stored sync token, follows pages until "up to date" (hard cap 1000
  pages), then applies all upserts/deletes **in one transaction** that also clears matching outbox entries and
  stores the new token. A 409 on a stale token restarts from a null token (full resync).
- **Triggers to run**: startup, any outbox change (live query), the setting being enabled, hourly, logout,
  and a `sync` WebSocket message for that collection. Failures on network/5xx/408/429 back off 4 s →
  doubling (capped); other errors stop.
- LWW is by updated-at: imports from older local preferences deliberately keep their old timestamps so any
  real edit beats them (migration comment). Column-level local-only data goes in a separate table.

### D. Transcripts — append-only chunks, uploaded on a timer (S7, S14) — confirmed

- Live transcript chunks (id, document id, source mic/system, start/end timestamps, text, is-final, speaker
  info, provider details) are merged into `transcripts[documentId]` in the **main encrypted JSON cache**,
  sorted by time; finals replace interims with the same id.
- New/changed chunk ids are added to `unsyncedTranscriptChunkIds[documentId]`. A periodic job uploads the
  marked chunks (skipping any inside "off the record" ranges) via `insert-transcriptions`. On success it
  removes only chunks whose **content is unchanged since upload** (a chunk edited mid-flight stays queued),
  then applies server-returned **PII redactions** to the local text.
- A separate recovery job can re-upload final chunks in a date window in batches of 50 (flag-driven, run
  once per flag id).
- Remote transcripts are fetched per document on demand (`get-document-transcript`). **inferred** (endpoint
  present; caller not traced). Transcript text is never edited collaboratively, so no conflict handling is needed.
- Local transcript copies can be deleted per document (not while that document is recording).

### E. Note bodies — Yjs over PartyKit + local Yjs log (S8, S13) — confirmed

- The TipTap editor for private notes and summary panels binds to a **Y.Doc** when collaboration is on
  (feature-flagged per content type with a "Yjs schema version", so a schema change starts a fresh Yjs doc).
- **Network**: a **y-partyserver `YProvider`** (Yjs sync + awareness over a PartyKit / Cloudflare Durable
  Object WebSocket room, plus BroadcastChannel between local windows). Room name derived from content type,
  version and id; auth token passed as a query param.
- **Local persistence** reimplements the y-indexeddb idea on SQLite: each Y update is appended to `ydocs`;
  once a doc has 500+ updates it is compacted (after 1 s idle) into one snapshot and older rows deleted. A
  live query on the table picks up updates written by another window. Unused Y.Docs are evicted after 30 s.
- **Seeding**: if the owner has no local Yjs state, the doc is initialised from the JSON notes; a non-owner
  without local state waits for the room's first sync and falls back to read-only JSON if it can't.
- The JSON/plain/Markdown copies on the `documents` row remain the list/search/AI representation and are what
  the document sync in §5A moves around, with Yjs state attached.
- Separately, a per-document "metadata" PartyKit room pushes panel-generation events (start/finish) to
  everyone viewing a document. **confirmed** (S11 @~6812939)

## 6. Realtime channel (S11) — confirmed

- One authenticated WebSocket per user (PartySocket reconnecting client; initial delay randomised 5–15 s,
  growth ×2, max 10 min; app-level ping/pong).
- Messages carry an optional **sequence number** and **message id**. The client stores the last seq and a
  list of processed ids in the cache: duplicates are skipped and, on reconnect, it sends a **replay request
  from the last seq**, so missed hints are recovered.
- Message types are mostly "go re-fetch X": `run_sync` (with entity type → ids, optional "immediate"), `sync`
  (collection), preferences, calendar refresh, workspace access/offers, briefs, automations, follow-ups,
  meeting-consent status, transcription stop requests, assistant alerts.
- A scheduler merges hints into a pending set and flushes either a **partial sync** (only the listed ids)
  or a **full sync**, debounced; it waits while the window is hidden unless the hint is immediate.
- Plus a polling backstop: periodic entity sync (interval from a feature flag) and calendar polling.

## 7. Conflict handling summary

| Data | Rule | Confidence |
|---|---|---|
| Document metadata / JSON notes | whole-row LWW on updated-at (max of doc and panel times); newer side overwrites | confirmed |
| Note bodies with Yjs | CRDT merge (room sync live; server merges uploaded Yjs state during document upsert) | confirmed (client), inferred (server) |
| Entities | LWW on updated-at per entity; pending local add/delete protected from pull | confirmed |
| Collections | LWW on updated-at; local pending edit beats incoming remote insert; versioned ack | confirmed |
| Transcripts | append-only, id-keyed; no conflicts by design | confirmed |
| Lost access / hard delete | server 403/409 → local copy deleted | confirmed |
| Local DB/cache corrupt or too new | wipe and resync from server | confirmed |

No "conflicted copy" concept was found anywhere. Losers of LWW are silently overwritten, except where Yjs
merges. **confirmed** absence in the paths read; **unknown** server-side history/versioning.

## 8. What syncs vs stays local

| Syncs | Stays local |
|---|---|
| documents (metadata + notes JSON/plain/MD + notes Yjs state) | FTS indexes, derived tag/attendee tables |
| AI panels (+ Yjs state) | Yjs update log itself (only the merged state is uploaded) |
| transcripts (uploaded chunks; server redacts PII) | audio (see audio-path.md; debug WAVs only) |
| entities: chat threads/messages, MCP connections, folder rule suggestions, automations | `localOnly` entity types; window/UI state; webcam/mic live state (cleared on boot) |
| dictation history (opt-in) and dictionary terms | dictionary usage stats (explicitly device-only) |
| preferences (separate preferences endpoint) | feature-flag cache, websocket seq, last-sync timestamps |
| calendar events, briefs (pulled from server/Google) | locally cached copies only |

## 9. Unknowns

- Server internals: how Yjs states are merged on upsert, whether document history/versions exist, how the
  document-set diff is computed server-side. **unknown**
- Purpose of the client clock-offset estimator and of the `*_encrypted` payload fields. **unknown**
- Where the SQLCipher key and the JSON DEK come from (keychain is likely). Deliberately **not investigated**.
- Exact transcript upload interval (constant imported from another chunk, not resolved). **unknown**

## Implications for Oat

Relevant to SPEC §5 (Postgres source of truth; desktop SQLite cache + outbox; LWW per doc + conflicted copy)
and PLAN 2.6 (persist segments via outbox) / 3.5 (desktop sync).

What we'd do the same:
1. **Local DB is a disposable cache.** Version the schema in the DB; if it's corrupt, too new, or a migration
   fails, wipe it and resync from Postgres. That's simpler and safer than clever repair, and it matches
   "Postgres is the source of truth".
2. **A trigger-driven outbox** like Granola's newest "collections" engine is the model for 2.6/3.5:
   - triggers on synced tables enqueue (table, id, deleted) into an outbox with a monotonically increasing version;
   - push sends current row values in version order and **acks by version**, so an ack for an old edit can't
     drop a newer one;
   - an "applying remote" flag stops pulled rows from re-entering the outbox;
   - pull uses an opaque cursor, pages until up to date, and applies each pull in one transaction that also
     clears matching outbox entries and saves the cursor;
   - a stale cursor makes the server return 409 and the client restarts from zero.
   We'd use this for **all** synced tables (documents, segments, pages) instead of Granola's mix of five mechanisms.
3. **Reactive UI from SQLite change notifications** (update hook → changed tables → re-run live queries).
   It removes polling and keeps sync writes and UI separate.
4. **Single writer, separate readers** for desktop SQLite, off the UI thread (our main-process store or a
   utility process). WAL mode.
5. **Realtime = invalidation hints with seq + replay**, data over HTTP. A per-user channel saying "pull
   collection X / ids Y", with sequence numbers and replay-from-seq on reconnect, plus a periodic poll
   backstop. That's much cheaper to build than streaming rows, and it fits Vercel (SSE or a hosted
   websocket service).
6. **Transcript segments are append-only, id-keyed, uploaded in batches**, and only cleared from the
   unsynced set if unchanged since upload. That's exactly PLAN 2.6. Keep them in SQLite (not a JSON blob as
   Granola does), so a crash mid-meeting loses nothing and the outbox covers them.
7. **Soft deletes with a retention window**, and server 403/410-style answers that tell the client to drop
   its copy.
8. **FTS5 locally** (trigram) for instant search across notes and transcripts.

What we'd do differently:
- **Conflicts:** Granola silently lets the last writer win for document rows. Our SPEC asks for
  LWW + version + **conflicted copy**. Implement it as: push carries the base version; the server rejects a
  push whose base version is stale (409-style); the client then keeps the server version as canonical and saves
  its own as a "conflicted copy" document. Granola has no equivalent; this is our own addition and stays.
- **No Yjs in MVP.** Granola needs Yjs because notes are co-edited live (PartyKit rooms). Oat's SPEC is
  single-writer LWW for M-early. Keep the editor wrapper Yjs-ready (bundle-map implication 6) but don't
  ship a CRDT backend until real-time co-editing is promoted from IDEAS.
- **One sync mechanism, not five.** Granola's layers (doc diff, entity op log, collection outbox, transcript
  uploader, Yjs) reflect history. We start with the outbox/cursor design for everything.
- **Encryption at rest** (SQLCipher DB + encrypted JSON cache with a keychain-held key) is a reasonable later
  hardening step. Log it in DECISIONS.md before adopting. Not in M1.
- **Keep main-process JSON state small.** Granola stores transcripts and the entity op log in one big
  encrypted JSON file that is rewritten whole every ≥10 s. We keep anything that grows (segments, outbox) in
  SQLite and keep JSON for small UI/session state only.
