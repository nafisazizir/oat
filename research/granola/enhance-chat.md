# Granola desktop: enhancement ("AI notes") and chat, client side (task 0.6)

Question: from the client's side, how do Granola's post-meeting enhancement and its chat work? This covers
what inputs are gathered, what triggers generation, the shape and transport of requests and streams, how AI
output lands in the editor and is told apart from the user's own notes, the template model, regenerate/undo,
chat scopes, citations, and tool use visible on the client.

Target: `/Applications/Granola.app`, `@granola/desktop` 7.786.3, 2026-11-14. Static structural reading of the
JS already extracted to `research/granola/raw/asar/` (tasks 0.2/0.3) with grep and small node scripts that
print offsets. No REA session was opened, nothing was executed against Granola, no network, no user data.
**Prompts live on the server and were not looked for.** The bundle does hold some UI copy, template
examples and one demo script. None of it is reproduced here. Variable names and endpoint/slug identifiers
are named only where they explain structure. All wording is ours.

Confidence: **confirmed** = read directly in shipped code · **inferred** = strong structural reading, not
observed end to end · **unknown** = not established.

## Evidence index

Offsets are character offsets into files under `research/granola/raw/asar/dist-app/assets/`. Minified names
are build-specific.

| ID | Location | What it shows |
|---|---|---|
| C1 | `gatherPromptInputsForDocument-zGAIDC81.js` @~226500–231900 | the client-side "prompt variables" bag built per document (notes, transcript, people, dates, flags), with two transcript formatters; attachments turned into extra user messages (@~231700) |
| C2 | `api-Ce100vjw.js` @242311–242700 | template and recipe CRUD endpoints (`get-panel-templates`, `create/update-panel-template`, `get/upsert/delete-recipe`) |
| C3 | `api-Ce100vjw.js` @~242950–245800 | `llm-proxy` (one-shot) and `llm-proxy-stream`: body = `{prompt_slug, prompt_variables, …}`, response = OpenAI-chat-style delta chunks split by a fixed boundary marker (`constants-CrUd1_5n.js`), with an optional reasoning channel |
| C4 | `api-Ce100vjw.js` @245832–247500 | `trigger-summary-generation` (with Idempotency-Key) returns a durable stream URL; reader resumes over SSE with backoff 1→16 s and skips chunks it already delivered |
| C5 | `api-Ce100vjw.js` @~199900–201900 (`fa`) and @257600–259400 | chat stream protocol: JSON events split by the same boundary marker; `chat-with-documents` request helper |
| C6 | `api-Ce100vjw.js` @264291 | `get-chat-citation` (lazy citation quote lookup) |
| C7 | `primary-CvQXJiuH.js` @553851–555900 | slug catalogs (built-in summary slugs, utility slugs, chat slugs) and the rule that maps a template value to built-in prompt / user template (UUID) / custom slug |
| C8 | `primary-CvQXJiuH.js` @~556000–566400 | panel generation state, streaming preview dispatch, completion and recovery; durable-stream event switch (@~565000) |
| C9 | `primary-CvQXJiuH.js` @566400–572600 | generation start: panel creation, empty Y.Doc seed, template → prompt variables, request body |
| C10 | `primary-CvQXJiuH.js` @572618–576000 | generate entry point: default template, A/B summary experiments, transcription comparison |
| C11 | `primary-CvQXJiuH.js` @~577500–581000 | auto-generation triggers at end of meeting / on stop |
| C12 | `primary-CvQXJiuH.js` @548500–552500, @3815164 | chat-driven note edits (text replace → block diff into the Y.Doc, animated) and the "rewrite" tool (new panel) |
| C13 | `primary-CvQXJiuH.js` @3838200–3846200, @3369209 | main chat send path: request body, outputs streaming, tool-call handling, persistence |
| C14 | `primary-CvQXJiuH.js` @~2976800–2980300, @~2991200 | citation rendering, lazy/prefetched quote fetch, popover |
| C15 | `primary-CvQXJiuH.js` @6782257–6784200 | "edited since generation" check and regenerate confirm |
| C16 | `primary-CvQXJiuH.js` @~6854900–6861800, @6875940–6876900, @6901670, @6904978 | read-only streaming renderer with per-block `data-generated`; `generatedLines` editor extension; panel listeners (incl. action-items insert) |
| C17 | `index-CS97OBtS.css` @607482 | styling rule: generated blocks use the secondary text colour |
| C18 | `cache-kv2l_fkS.js` @140240 | streaming Markdown → HTML conversion (markdown-it, task lists) |
| C19 | `useCollapsiblePanel-C_y4lCvU.js` @~10700–12800, @~35900–41900 | chat schemas: tool-call envelope, citation shape, view context union, output union, `chat_thread`/`chat_message` entities |
| C20 | `multiChatStore-Bo5OCqFP.js` (whole) | chat UI store: per-thread streaming state, recipes menu, document picker, model choice (single/multi), hovered citation |
| C21 | `primary-CvQXJiuH.js` @4117553 | transcript edited → offer to regenerate |

## 1. Big picture

```
 renderer (primary window)                          server
 ──────────────────────────                          ──────
 gather inputs (C1) ─┐
 template → vars (C9)├─► POST trigger-summary-generation ─► job runs the prompt (by slug) ─► durable stream
 empty Y.Doc seed ───┘        (idempotency key)                                              │
                                                                                             ▼
 read-only preview ◄── completion deltas (Markdown) ◄──────────── SSE, resumable (C4) ◄───────┤
 generated-lines set ◄─ generated_lines event ◄──────────────────────────────────────────────┤
 panel row + Y.Doc  ◄── ydoc event (final doc state + original) + completed{char count} ◄────┘
```

- **The server owns prompts and the generation job; the client sends named variables.** Every LLM call
  goes through a `prompt_slug` + `prompt_variables` envelope (one-shot, streaming, or durable). Prompt text
  is not in the bundle. **confirmed** (C3, C7, C9)
- **Enhanced notes are a separate object from the user's notes.** A meeting document keeps the user's own
  notes. Each AI output is a **panel** (`document_panels` row, see `storage-sync.md` §3) with its own Y.Doc,
  template slug, `original_content` and `generated_lines`. Enhancing never rewrites the user's note body.
  **confirmed** (C8, C9)
- Two transports: (a) current path, a **durable, server-run job** whose stream the client can re-attach
  to after a crash or network drop; (b) older/lighter path, a direct streaming proxy (`llm-proxy-stream`),
  still used by other features. The code calls the routes `durable` and `background`. **confirmed** (C4,
  C8)

## 2. Inputs gathered on the client (C1, C9)

One function builds a flat key → value map per document. All values are strings, numbers or booleans,
ready for server-side templating. **confirmed**

- **Notes:** Markdown of the live editor if available, else the stored Markdown, else plain text. Derived
  extras: the user's own `#` headings as a list, URLs found in the notes, and a "has long notes" flag
  (≥ 20 non-empty lines).
- **Transcript:** formatted **on the client** into one speaker-labelled text block. It uses room names and
  detected speaker names, can work at word level (feature flag), and can drop the mic fallback when no
  system audio exists. It also produces length, "is short" (< 200 chars) and "has speaker attribution"
  flags. If transcript chunks were deleted and nothing else is left, generation is skipped.
- **People:** creator (name, email, a short self-description built from job title, company and company
  description), attendees with title/company, colleagues vs external attendees split **by email domain**,
  external company names, a natural-language participant list, and group/large-group annotations.
- **Viewer profile:** viewer's name, bio and company (the viewer can differ from the creator on shared
  notes).
- **Meeting metadata:** calendar title (fallback: doc title), date and time in the user's time zone,
  today's date, document id, tags.
- **Locale/language switches:** multi-language transcription, English-only summary, British English
  (from system locale), and the user's custom dictionary terms.
- **Context flags:** iOS-created, collaborative doc, user type (e.g. a VC persona flag).
- **Previous summary:** used by chat and by "rewrite" (latest panel's Markdown, with any appended chat
  section stripped).
- **Attachments:** sent separately as extra **user messages** in a `chat_history` array: extracted text for
  documents, image URLs for images. **confirmed**
- **Template variables (when a user template is chosen):** the template's sections flattened to a
  heading-plus-instruction list, the first heading, the template description and title, and a **max
  number of headings scaled to transcript length** (4 for short up to 8 for long). **confirmed**
- **Request extras:** panel id/title, template slug, the seeded Y.Doc state + schema version, `auto` flag,
  an action-item-extraction slug, flags to suppress a transcript footer and to force user context, and
  experiment overrides. **confirmed** (C9)
- Before triggering, the client makes sure the document exists on the server (repairs on 404), waits for
  speaker attribution, and kicks off screen-share context prep in parallel. **confirmed** call order;
  purpose of each wait **inferred**.

## 3. Triggers (C10, C11, C21)

- **Auto at end of meeting:** runs only if the document has no panels yet and the transcript is at least
  ~2,500 characters. It is skipped if recording resumed during the checks. **confirmed**
- **Auto on stop:** when transcription stops, no panels exist and recording ran ≥ 3 min. If "now" is within
  ±5 min of the calendar event's end, generation is scheduled. Otherwise a **small LLM check on the last
  ~100 words of transcript** decides whether the meeting really ended. Generation then fires after ~10 s
  unless recording resumes. **confirmed** (the 10 s unit is **inferred** from a shared time constant)
- **Manual:** a generate action in the meeting view. A template picked before or during the meeting can be
  held as a "temporary template" and used for the auto run. **confirmed**
- **After transcript edits:** when transcript lines are deleted, a toast offers to regenerate. **confirmed**
- The server can refuse an auto run (`auto_generation_blocked`). The client then deletes the placeholder
  panel and re-syncs panels. **confirmed**
- Experiments: the same entry point can create **two panels side by side** for prompt A/B tests or
  transcription-engine comparisons, randomising which one is primary. **confirmed** (C10)

## 4. Request / stream shape (C3, C4, C8)

**Durable path (enhancement today).**
1. Create the panel locally first: new UUID, title from template, `generation_started_at` = now, Y.Doc
   seeded with one empty paragraph and a "seeded" marker. Write to SQLite and push to the server.
2. Save a **pending attempt** in `localStorage` (keyed per user + panel, expires after ~14 min), then POST
   `trigger-summary-generation` with an **Idempotency-Key = attempt id**. Retry 2 s/5 s/10 s on transient
   errors. Any 4xx other than 408/429 is fatal. The response is a **stream URL**, which is saved over the
   pending attempt.
3. Read the stream as JSON events over SSE (Electric "durable streams" client, from offset −1). On a drop,
   reconnect and skip already-delivered events. Event types:
   `panel_id` (sanity check) · `completion` (OpenAI-style delta text) · `generated_lines` (see §5) ·
   `ydoc` (final Y.Doc state + version + original content) · `completed` (panel id + expected character
   count, checked against what was received) · `failed` (code, e.g. already-in-progress, auto-blocked).
4. On `completed`, convert the Y.Doc to ProseMirror JSON, save `content`, `original_content`,
   `generated_lines`, `content_updated_at` and the Y.Doc state locally, then notify listeners.
5. **Recovery:** on launch or reopen, a saved attempt resumes the stream. If the stream is gone, the
   client fetches the panel from the server (with Y.Doc state) and adopts it if completed. Otherwise it
   waits or marks the panel failed (3-minute staleness rule, `storage-sync.md` §3). Other viewers learn
   about generation start/finish through the per-document metadata room (`storage-sync.md` §5E).
   **confirmed**

**Streaming proxy path** (`llm-proxy-stream`, also one-shot `llm-proxy`): POST `{prompt_slug,
prompt_variables, panel_id?}`. The response is a text body of chat-completion chunks separated by a fixed
boundary string. The client accumulates the text, calls a delta callback with (full text, delta), and keeps
a separate reasoning accumulator. 30 s timeout, 2 retries, timing telemetry (TTFB, chunks). Used for titles,
the did-meeting-end check, speaker-name suggestions and the like. **confirmed**

**Output format:** the model's streamed text is **Markdown** (task lists, links). The authoritative
structured document arrives as a **server-built Y.Doc**, not as JSON blocks the client converts. **confirmed**
(C8, C18)

## 5. How AI output lands and is told apart from the user's notes (C8, C16, C17)

- **While streaming**, the panel shows a **read-only preview**, not the editor. Only complete lines are
  rendered (the trailing partial line is held back). Each update is converted Markdown → HTML → node tree
  and drawn by a small React renderer with staggered entrance motion. **confirmed**
- **On completion** the preview is swapped for the TipTap editor bound to the panel's Y.Doc (collaborative,
  editable). **confirmed**
- **"Mine vs AI" marking is by line text, not stored marks.** The server returns `generated_lines`, a list
  of line strings the model wrote (as opposed to lines carried over from the user's notes). The renderer
  and a `generatedLines` editor extension (a ProseMirror plugin state = set of strings, plus decorations)
  set `data-generated=true|false` on each block by comparing its trimmed text with that set. CSS then gives
  generated blocks the **secondary (muted) colour**, so the user's own content stands out in the primary
  colour. Editing a generated line changes its text, so it stops matching and loses the muted style.
  **confirmed** mechanism; the last point is **inferred**.
- **Action items:** a separate extraction (own slug) can produce high-priority items. A listener inserts a
  heading + task list at the top of the panel, and action-item HTML attributes refresh an action-items
  query. **confirmed** presence; full flow **inferred**.
- `original_content` keeps the as-generated document, used to detect user edits (§7). **confirmed**

## 6. Template model (C2, C7, C9, template editor @~2615800–2638200)

- A **panel template** has: id (UUID), title, description, icon, and an ordered list of **sections**, each
  with `{id, heading, section_description}`. Section descriptions are free-text instructions per section.
  The editor lets users add, remove, reorder (drag) and edit sections. Templates are fetched and saved via
  dedicated endpoints and cached in app state. **confirmed**
- **One prompt serves all user templates.** A UUID template value maps to one server prompt slug for
  "template summaries". The template's sections, description and title are passed as variables. A
  non-UUID value is a **built-in prompt slug** (a short list of consolidated / notes-centric variants,
  possibly with a `v2:` prefix). Anything else is treated as a custom slug. The default when nothing is
  chosen is a built-in consolidated meeting summary. **confirmed**
- A panel stores the `template_slug` it was generated with, so switching template = generating another
  panel with a different slug. **confirmed**
- **Recipes** are a separate concept: saved, shareable chat prompts (with author, workspace, publisher)
  launched from a menu or chips in chat. They are not note templates. **confirmed** presence (C2, C20, C13)

## 7. Regenerate / undo (C9, C12, C15)

- Regenerating **creates a new panel row** (new id) unless a specific panel id is passed. The panel list
  shows the most recently viewed panel, and older panels are not deleted by this path. **confirmed**
  (panel factory, `ok`); how old tabs are presented is **unknown**.
- Before regenerating with the **same template**, the client checks whether the user edited the current
  panel: it compares `content` with `original_content`, first as JSON, then as normalised Markdown. If it
  was edited, a destructive confirm dialog appears. With a different template, no prompt. **confirmed**
- **No undo for enhancement was found** (no restore-original action using `original_content` in this
  build). Undo of chat edits is plain editor/Yjs undo. **inferred**
- A failed generation leaves the user's notes and transcript untouched and offers a retry. **confirmed**

## 8. Chat (C5, C13, C19, C20)

**Scopes.** Each message carries a typed **view context**, a tagged union over: single meeting, live
meeting, global (all notes), folder/list (with folder metadata, files, space type), shared-with-me,
search (person / company / freeform, with document ids) and saved view. The request also carries a short
`chat_context` string (e.g. meeting / search / global / list), explicit `document_ids`, an optional
`list_id`, and the user's selected or @-mentioned documents. **confirmed**

**Request** (`chat-with-documents`, web variant for the browser build): thread id, assistant message id
(client-generated), thread-creation info, `chat_history` (prior turns), document ids / list id,
transcripts on/off (transcripts are excluded for large selections, more than 25), web-search flag,
edit-with-AI flag, attachment ids, user time zone, and `prompt_config` {model, response style,
`input_values`}. For single-meeting chat, `input_values` is the **same variable bag as enhancement** (§2)
plus the user's selected editor text and the current summary. Models: per-scope choice (single vs multi),
default "auto", list from `get-chat-models`. Timeout 60 s, 2 retries. **confirmed**

**Stream:** JSON events split by the same boundary marker:
`text_delta` · `context_sources_delta` (total sources, scanned documents, citation ids, web results) ·
`context_limit_reached` · `outputs` / `output_delta` (structured output list, replaced or patched by index)
· `stream_completed` (final text, reasoning text + duration, outputs, metadata, content type plain or
"with citations", **changed blocks**, trace ids) · `error`. **confirmed**

**Outputs** are a list of typed parts: reasoning, plain text, **text-with-citations** (response lines, each
with its own citations), tool calls, and **draft previews** (email, Slack message, Linear ticket batch,
calendar event, code-plan artifacts with status and confidence). **confirmed** (C19)

**Persistence:** `chat_thread` and `chat_message` are synced entities (op-log sync, `storage-sync.md` §5B).
A message stores role, turn index, raw text, the view context, sources and outputs, status. Thread titles
come from a separate one-shot prompt. Stopping a response keeps the partial answer and marks it stopped.
**confirmed**

**In-meeting chat:** a live-meeting context, quick asks (catch-up, explain, follow-up questions) that slice
the recent transcript by character budget around a point, and a global-shortcut quick-chat window that
forwards into the main chat (`bundle-map.md` §3). **confirmed** presence

## 9. Citations (C6, C14, C19)

- A cited answer is a list of **response lines** `{line_index, answer_text, citations[]}`. Each citation
  has a meeting id, the line index, an optional **source type** (transcript, summary, pre-meeting brief,
  email, calendar, web), an optional **source quote**, and email/calendar/web references. **confirmed**
- Citations usually arrive **without the quote**. The client fills it lazily: it prefetches the first
  citation of each line while streaming and fetches others on hover via `get-chat-citation` {answer text,
  meeting id, exclude-transcript}. The server returns the quote and its type. Results are cached per
  stream. **confirmed**
- UI: numbered markers per line. The popover shows the quote labelled as transcript or summary. Hovering a
  citation also highlights the cited meeting in note lists. **No jump to a transcript timestamp was found**:
  the quote's click handler is empty and citations carry no segment id or time. **confirmed** (C14)

## 10. Tool use visible on the client (C12, C13, C19)

- Tool calls stream as output parts with a common envelope: id, streaming args, provider-executed flag,
  started/completed times, error, "reverted", confirmation status and an **approval object**
  (pending / approved / denied, with proposed args). Most tools run **on the server** (the client renders
  them). The registry is large: meeting search/read/transcript search, people/company lookup, calendar
  read/write, email and Slack drafting, CRM fields, Google Docs, folders, web search/fetch, code execution,
  image/diagram generation, MCP tools (via `mcp-tool-execute`), and a tool-search meta tool. **confirmed**
  names/shapes; execution location **inferred** from the provider-executed flag.
- **Two tools act on the meeting notes client-side:**
  - *edit notes*: args include a `textToReplace` (+ replacement). While streaming, the client finds and
    highlights the target text in the open panel editor. After the answer it applies all edits as
    **Markdown text replacements** on the summary panel, rebuilds only the changed blocks in the Y.Doc
    (common prefix/suffix diff by block), and animates the rewrite. Edits are serialised through a promise
    queue, and failures are marked on the tool call. **confirmed**
  - *rewrite notes*: creates a **new panel** with the same template, passing rewrite instructions + the
    previous summary as variables. **confirmed**
- Approval-gated tools: on approve/deny the client patches the stored assistant message's tool-call output
  and continues the thread. **confirmed** presence; full loop **inferred**.

## Implications for Oat

Relevant to SPEC §7 (AI behaviour) and PLAN M4 (4.3–4.6) / M6 (6.2–6.4). These are suggestions, not
decisions. Changes to SPEC need a DECISIONS entry.

1. **Keep AI output in a separate object from my notes** (Granola's panel model). Oat's SPEC says
   "blocks derived from my notes are marked". Granola does it by line-text matching against a returned
   `generated_lines` set, which is fragile once the user edits. Oat should mark provenance **in the
   TipTap JSON itself** (a block attribute such as `origin: "mine" | "ai"` set during the structured →
   TipTap conversion) and render the muted style from that. Same visual idea, sturdier mechanism. (4.4)
2. **Structured JSON output is a real improvement over their Markdown stream**, but streaming still
   matters. Pattern to copy: show a read-only preview built from partial output (AI SDK `streamObject`
   partial objects), and only write the final validated doc into the editor at the end, in one
   transaction. (4.4)
3. **Make generation a server job with a resumable stream and an idempotency key**, persisting a pending
   attempt locally so a crash or reload re-attaches instead of re-spending tokens. In Oat terms: an
   `enhance_runs` row + a resumable SSE (or AI SDK resumable streams). Keep a panel/run state machine
   (idle → generating → completed/failed, with a staleness timeout). (4.4, later eve in M8)
4. **Template = ordered sections {heading, instructions} + title/description, and one server prompt for
   all user templates.** Scale the section budget to transcript length. Store the template id on each
   output so "switch template" = new output. Built-ins can be the same schema. (4.3)
5. **Regenerate should not silently destroy edits:** keep `original` vs `current` per output, warn when
   they differ, and (where Granola falls short) keep previous outputs as versions so undo exists. (4.5)
6. **Inputs worth mirroring:** notes Markdown + user's own headings, speaker-labelled transcript text,
   colleagues vs externals by email domain, about-me/viewer bio, locale/language switches, custom
   vocabulary, attachments as extra user content. Build them in one shared function used by both enhance and
   single-note chat. (4.4, 4.6, 6.3)
7. **Auto-enhance heuristics** to copy: no existing output, minimum transcript length, near calendar end,
   or a cheap "did the meeting end?" model check, then a short grace delay cancelled by resume. (4.4/M7)
8. **Chat scope as a typed context union** (note, live note, folder, search result, workspace) stored on
   each message, plus explicit document ids. Drop transcripts for large selections and rely on
   retrieval. (6.3)
9. **Citations: do better than Granola.** Their citations are per answer line with a lazily fetched quote
   and no timestamp. Oat's SPEC wants claims to cite transcript segments or note blocks: have retrieval
   tools return segment ids + timestamps / block ids so citations are exact and can jump to audio/
   transcript time (6.4, 3.7). A lazy "resolve quote" endpoint is a fallback, not the plan.
10. **Note-editing tools:** an edit tool as find/replace on the note's Markdown applied as a minimal
    block diff (with highlight + animation), and a rewrite tool that produces a new output rather than
    overwriting. Gate writes behind confirmation/approval states on the tool call. (6.2 `updateDocument`)
11. Granola has a large tool surface and a stream with reasoning, draft previews and context-limit events.
    For M6, stick to the PLAN's small tool set. Design the message-parts schema (text, cited text, tool
    call with approval, reasoning) so it can grow.

## Unknowns

- Server-side behaviour: how the job builds the Y.Doc, how `generated_lines` are chosen, and how prompts use
  the variables. Out of scope (clean room).
- Whether old panels are hidden or shown as tabs after regenerate.
- Exact semantics of `strip_notes_tag`, `force_user_context` and the transcript-footer flag.
- Whether any tool other than the two note-edit tools executes in the renderer.
