# Oat — Product & Technical Spec

Status: draft v0.1 · 2026-11-14 · Owner: human (product), agents (implementation)

## 1. Vision

A meeting-notes app that feels like *mine*. It sits quietly on the desktop, notices when a call starts,
captures both sides of the conversation without a bot joining, and lets me jot rough notes while the AI
does the heavy lifting afterwards. Notes live in a Notion-like space: private pages for me, shared spaces
for a team, and assistants I can talk to about everything that was ever said.

Granola is the reference product for the *core loop*. Everything around it (workspace model, assistants,
integrations, look and feel) is ours to shape.

## 2. Users

- **Me (primary):** heavy meeting load, wants zero-friction capture and notes that go where I work.
- **Browser meetings:** record mic ("me") and optional shared-tab audio ("them") on the web (D-32).
  Desktop remains the path for native call apps; browser audio stays device-local in OPFS, never uploaded.
- **My team (secondary):** read shared notes, collaborate in team spaces, ask the assistant about meetings
  they weren't in.

## 3. Core loop (the thing that must be great)

1. **Detect** — a calendar event is starting, or a meeting app starts using the mic → prompt "Start notes?".
2. **Capture** — record mic (= "me") and system audio (= "them") as two separate streams. No bot. Audio is
   archived in a local cache on this machine for reference (never uploaded); only the transcript syncs.
   In the browser, the second stream is shared-tab audio, not native system capture (D-32).
3. **Transcribe live** — streaming speech-to-text, segments shown in a transcript panel, labelled by source.
4. **Jot** — I type rough notes in an editor during the call. My notes are the signal of what mattered.
5. **Enhance** — after the call, the AI merges my notes + transcript + a template into structured notes.
   My own text stays visually distinct from AI-added text.
6. **Use** — ask follow-ups ("what did we decide about X?"), share, push to Notion/Slack, extract action items.

## 4. Feature scope

### v1 ("ready") — must have
| Area | Requirement |
|---|---|
| Capture | Mic + system audio on macOS (Apple Silicon, macOS 14.4+), start/stop/pause, survives sleep/network drops (buffers and resumes). |
| Browser capture (D-32) | Mic + optional shared browser-tab audio; start/stop/pause, visible errors, reconnect replay and retrying transcript sync. Warn before leaving; loss of tab sharing does not stop mic capture. Device-local OPFS Opus/WebM archive per source/part; transcript-linked playback and local audio deletion. No audio storage upload or sync. |
| Audio archive | Every recording saved locally (per meeting, mic and system as separate Opus files), playback synced to the transcript (click a segment → jump to audio), retention settings (keep forever / N days / max GB), delete per meeting, "show in Finder". Local only — never synced. |
| Transcription | Live streaming STT, two-source labelling (me/them), stored as timestamped segments. |
| Editor | TipTap block editor (headings, lists, checklists, quotes, code, callouts, mentions, links), slash menu, Markdown shortcuts. |
| Enhance | Template-driven enhancement, built-in templates (general, 1:1, sales/discovery, standup, interview), custom templates, regenerate. |
| Workspace | One kind of workspace (D-36): on sign-up join an existing one (invite or email-domain match, per its join policy) or get one created. Inside: Private and Shared sections; folders; documents = meeting notes or plain pages. |
| Auth | Email magic link + Google OAuth; desktop signs in via browser + deep link. |
| Sharing | Visibility: private / workspace / anyone-with-link (read-only web view). Invite members with roles (owner, admin, member, viewer). |
| Assistant | Chat scoped to one note, and chat across all notes I can access (retrieval over transcripts + notes) with citations back to segments. |
| Calendar | Upcoming meetings list (macOS EventKit first), attendees attached to the meeting note. |
| Detection | Meeting-app-using-mic detection → notification to start recording. |
| Integrations | Export/sync a note to Notion; copy as Markdown. |
| Search | Full-text + semantic search across notes and transcripts. |

### Later (see `IDEAS.md`)
Slack/Linear/email integrations, background agents (post-meeting pipelines, digests), local-only
transcription, Windows, mobile, real-time co-editing, people pages, custom assistants.

### Non-goals for v1
- Real-time multi-cursor collaboration (sharing is enough).
- Uploading or syncing audio to the cloud (audio stays in the local archive).
- A bot that joins calls.
- Pixel parity with Granola.

## 5. Architecture

```
┌──────────────────────── apps/desktop (Electron) ────────────────────────┐
│ main process                                                             │
│  ├─ capture: spawns `oat-audio` Swift sidecar ─ PCM frames (mic/system)  │
│  ├─ stt: streams frames → STT provider (Deepgram) → segments             │
│  ├─ detect: meeting-app/mic-usage + calendar (EventKit)                  │
│  ├─ store: SQLite cache (documents, segments, outbox)                    │
│  └─ sync: outbox → apps/web API; pull changes                            │
│ renderer: React + packages/ui + packages/editor                          │
└──────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS (session token from deep-link auth)
┌──────────────────────── apps/web (Next.js on Vercel) ───────────────────┐
│ API routes / server actions · Better Auth · share-link web viewer        │
│ AI: enhance, chat, embeddings (AI SDK → AI Gateway)                      │
│ Postgres (Neon) + pgvector via Drizzle                                   │
│ (M8+) eve agents: post-meeting pipeline, schedules, Slack channel        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Repo layout
```
apps/desktop        Electron + electron-vite + React
apps/web            Next.js App Router (API, auth, web app, share viewer)
native/oat-audio    Swift package: CLI sidecar for mic + system-audio capture
packages/ui         shadcn/ui components + design tokens (CSS variables)
packages/editor     TipTap extensions, schema, JSON↔Markdown conversion
packages/db         Drizzle schema (Postgres) + migrations; shared types
packages/ai         prompts, templates, tools, model config (AI SDK)
packages/stt        STT provider interface + Deepgram impl + fake impl for tests
packages/core       domain types, permissions logic, sync protocol
agents/             (M8+) eve agents
research/granola    reverse-engineering findings (reference only)
docs/               spec, plan, factory, decisions, tasks, log
```

### Key technical decisions (details + rationale in `DECISIONS.md`)
- **Electron + Vite** for desktop (matches Granola; confirmed in recon). macOS first.
- **Audio capture in a Swift sidecar binary**, not a Node addon: crash isolation, simpler build, streams
  length-prefixed PCM frames tagged `mic`/`system` over stdout. System audio via Core Audio process taps
  (macOS 14.4+), mic via AVAudioEngine. A Node addon can replace it later if needed.
- **`AudioSource` interface** with `SidecarSource` and `FileSource` (plays WAV fixtures at real-time or
  faster). This is what makes the pipeline testable by agents without a human or a microphone.
- **STT behind `SttProvider`**: Deepgram streaming first, `FakeSttProvider` for tests, local
  (Whisper/Parakeet) later.
- **Editor content is TipTap/ProseMirror JSON** (canonical). Markdown is derived for AI input, export and
  Notion sync. Never store Markdown as the source of truth.
- **Postgres is the source of truth**; desktop SQLite is a cache plus an outbox for offline writes.
  One sync mechanism for every table (trigger-driven outbox, version acks, cursor pull, SSE invalidation —
  D-19); a stale base version on push creates a "conflicted copy" rather than merging or overwriting.
- **Everything carries `workspace_id`.** There is no personal workspace (D-36): private notes are `private` items inside a workspace.
- **AI via Vercel AI SDK + AI Gateway** (`"provider/model"` strings). Default to the current Claude models;
  verify exact model IDs against the gateway's model list at implementation time.
- **Assistants:** interactive chat = AI SDK tool loop in `apps/web`. Durable/background agents = eve
  (evaluate at M8 by reading `node_modules/eve/docs/` first). Tools are plain functions in `packages/ai`
  so both can reuse them.
- **UI:** shadcn/ui + Tailwind with all colour/spacing/radius/typography as CSS-variable tokens in
  `packages/ui`. Layout and flows may take inspiration from Granola; visual identity is ours. Swapping in a
  real design system later = changing tokens + restyling a few components.

## 6. Data model (Postgres, v1)

```
user(id, email, name, image, created_at)
workspace(id, name, join_policy: invite_only|request|auto_join, created_by, created_at)   -- D-36
workspace_domain(workspace_id, domain)
join_request(id, workspace_id, user_id, status: pending|approved|declined, decided_by?)
membership(workspace_id, user_id, role: owner|admin|member|viewer)
invite(id, workspace_id, email, role, token, expires_at, accepted_at)
folder(id, workspace_id, parent_id?, name, visibility: private|workspace, owner_id)
document(id, workspace_id, folder_id?, owner_id, kind: meeting|page, title,
         content_json, content_md (derived), visibility: private|workspace|link,
         share_token?, version, created_at, updated_at, deleted_at?)
meeting(id, document_id, calendar_event_id?, started_at, ended_at, platform?, template_id?)
participant(meeting_id, name, email?, source: calendar|manual)
transcript_segment(id /* client-generated, stable */, meeting_id, source: mic|system, speaker_label?, start_ms, end_ms,
                   text, is_final, created_at)
enhancement(id, document_id, template_id, model, input_hash, input_notes_json, output_json,
            status: generating|completed|failed, idempotency_key, started_at, completed_at, created_at)  -- D-20
template(id, workspace_id?, name, instructions, sections_json, is_builtin)
chunk(id, workspace_id, document_id, segment_range?, text, embedding vector)   -- retrieval
chat_thread(id, workspace_id, user_id, scope: document|workspace, document_id?, title)
chat_message(id, thread_id, role, parts_json, context_json, created_at)
integration(id, workspace_id, user_id, provider: notion|google|slack, credentials_ref, settings_json)
```
### Desktop-only (SQLite + filesystem, never synced)
```
audio_recording(id, meeting_id, source: mic|system, part, offset_ms, path, codec: opus, sample_rate,
                started_at, duration_ms, bytes, status: recording|complete|partial|failed|deleted)  -- D-24
```
Files live at `~/Library/Application Support/Oat/audio/<meeting_id>/{mic,system}.opus` (Ogg Opus, mono,
~24 kbps each → roughly 20 MB per meeting-hour for both). They are written incrementally while recording so a
crash keeps everything up to the last flush (`status: partial`). Segment `start_ms` values share the
recording's clock so playback can seek to any segment. Encryption at rest relies on FileVault for v1.
Other devices/teammates see the transcript but no audio; the UI says "audio on <device name>" when relevant.

Permissions are computed in one place (`packages/core/permissions.ts`) and covered by tests:
a user can read a document if they own it, or it's `workspace` visibility and they're a member, or they
hold the share token for `link` visibility.

## 7. AI behaviour

- **Enhance input:** template + my notes (Markdown) + transcript (segments with source + timestamps) +
  meeting metadata (title, attendees) + optional "about me" profile.
- **Enhance output:** structured JSON (sections → blocks) validated with a schema, converted to TipTap JSON
  whose blocks carry `origin: me | ai` so the UI renders them differently. Raw notes and every output are
  kept for undo/restore (D-20).
- **Grounding:** every factual claim in chat answers cites transcript segments or note blocks.
- **Evals:** `packages/ai/evals/` holds fixture meetings (transcript + notes + expected properties).
  Enhancement and chat changes must not regress eval scores (see FACTORY verification).

## 8. Quality bars

- Live transcript latency: < 1.5 s from speech to a visible interim segment.
- Recording never silently stops: errors surface in UI; audio buffers locally while STT is down and
  is replayed on reconnect.
- Enhance completes in < 30 s for a 1-hour meeting.
- Cold start of desktop app < 2 s to an interactive window.
- No secrets in the renderer; desktop talks to the API with a revocable session token stored in Keychain.

## 9. Definition of "ready" (v1)

All v1 rows in §4 are implemented, every milestone through M7 in `PLAN.md` is checked with verification
evidence, the end-to-end acceptance script (`PLAN.md` → M9) passes on a clean machine, and the human has
used it for real meetings for one week and signed off.

## 10. Open questions (human to answer; agents use the defaults until then)

All answered (D-10, D-14): Better Auth · Deepgram streaming behind `SttProvider` (local later) · audio kept
locally only · no Windows in v1 · name "Oat".

## 11. Development environment

Fully containerised and offline (D-11, D-13): `pnpm dev:up` starts Postgres+pgvector, Redis, Mailpit,
a mock OAuth/OIDC server and `tools/mocks` (OpenAI-compatible LLM + embeddings, Deepgram-compatible STT
websocket, Notion and Google Calendar subsets). No keys needed for dev or tests. See `docs/DEV.md`.
