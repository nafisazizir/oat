/**
 * The assistant's tools as plain async functions (6.2, D-7): `(ctx, input) → JSON-able output`. Wrapped
 * for the AI SDK by `createAssistantTools` (`./ai-tools.ts`); eve agents (M8) can wrap the same functions.
 *
 * Rules every tool follows:
 * - **Permissions are re-checked here**, on every row, with `@oat/core` (`canReadDocument` /
 *   `canEditDocument`), whatever the data source already filtered. Share tokens never count. Trashed
 *   documents are invisible. Anything outside the chat's scope (one document, or one workspace) is treated
 *   exactly like something that doesn't exist: `{ error: 'not_found' }`, so the model can't probe for ids.
 * - **Content is fenced as data**: user-written text (titles, notes, transcript lines, names) goes into the
 *   output tag-neutralised and inside `<oat:…>` blocks; `[[` is defused so content can't forge a citation
 *   marker. The system prompt tells the model to treat it as data.
 * - **Citations**: every citable item carries the exact marker to copy — `[[seg:<segment id>]]` for
 *   transcript lines, `[[block:<block id>]]` for note blocks (`getDocument` shows block ids as
 *   `<!-- id=… -->`). The chat route only keeps markers whose ids appeared in tool output
 *   (`../chat/citations.ts`).
 * - `updateDocument` **never writes**: it returns a pending proposal for the user to approve.
 */
import { canEditDocument, canReadDocument, type PermissionContext } from '@oat/core';
import { toMarkdown } from '@oat/editor/markdown';
import { clock, estimateTokens, neutralizeTags } from '../context.ts';
import { applyTextEdits, blockPlainText } from './edit.ts';
import type {
  DocumentRecord,
  EditProposal,
  MeetingRecord,
  SegmentRecord,
  TextEdit,
  ToolContext,
} from './types.ts';

type MarkdownDoc = Parameters<typeof toMarkdown>[0];

/** Caps that keep tool output inside a sane context budget. */
export const TOOL_LIMITS = {
  searchResults: 8,
  maxSearchResults: 12,
  /** Excerpts (segments / blocks) shown per search hit. */
  excerptsPerHit: 6,
  excerptChars: 600,
  documentTokens: 12_000,
  transcriptSegments: 300,
  transcriptTokens: 10_000,
  meetings: 20,
  maxMeetings: 50,
  titleChars: 300,
} as const;

export type ToolError = { error: 'not_found' | 'forbidden' | 'invalid_input'; message: string };

const notFound = (what: string): ToolError => ({
  error: 'not_found',
  message: `${what} not found (or not available in this chat).`,
});

// ---------------------------------------------------------------------------------------------------------
// Fencing
// ---------------------------------------------------------------------------------------------------------

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A copy of TipTap JSON whose text can't contain `<!--`, so only the serializer writes block annotations
 * (`<!-- id=… -->`) into a document's Markdown.
 */
function defuseDocText(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(defuseDocText);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === 'text' && typeof value === 'string' ? defuseComments(value) : defuseDocText(value);
  }
  return out;
}

/** `<!--` → `<` ZWSP `!--`: content can't fake a block annotation. */
const defuseComments = (text: string) => text.replace(/<!--/g, '<\u200B!--');

/**
 * Untrusted text made safe to embed: no `<oat:` tags, no `[[` citation markers, no `<!--` block annotations
 * (`keepComments` only for Markdown whose content was already defused with `defuseDocText`).
 */
export function defuse(text: string, options: { keepComments?: boolean } = {}): string {
  const out = neutralizeTags(text).replace(/\[\[/g, '[\u200B[').replace(/\]\]/g, ']\u200B]');
  return options.keepComments ? out : defuseComments(out);
}

/** `<oat:tag>` … `</oat:tag>` around defused content (single line when `inline`). */
export function fence(
  tag: string,
  text: string,
  inline = false,
  options: { keepComments?: boolean } = {},
): string {
  const body = defuse(inline ? oneLine(text) : text, options);
  return inline ? `<oat:${tag}>${body}</oat:${tag}>` : `<oat:${tag}>\n${body}\n</oat:${tag}>`;
}

/** A title/name: one line, defused, capped. */
export const label = (text: string, max: number = TOOL_LIMITS.titleChars) =>
  defuse(oneLine(text)).slice(0, max) || '(untitled)';

const cap = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export const segCite = (id: string) => `[[seg:${id}]]`;
export const blockCite = (id: string) => `[[block:${id}]]`;

// ---------------------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------------------

/** The actor without any share token. */
function actorOnly(ctx: ToolContext): PermissionContext {
  return { userId: ctx.permissions.userId, memberships: ctx.permissions.memberships };
}

function inScope(ctx: ToolContext, doc: Pick<DocumentRecord, 'id' | 'workspaceId'>): boolean {
  if (doc.workspaceId !== ctx.scope.workspaceId) return false;
  return ctx.scope.kind !== 'document' || doc.id === ctx.scope.documentId;
}

/** Readable, live and in scope. */
export function canSee(ctx: ToolContext, doc: Omit<DocumentRecord, 'contentJson'>): boolean {
  return doc.deletedAt === null && inScope(ctx, doc) && canReadDocument(actorOnly(ctx), doc);
}

async function visibleDocument(ctx: ToolContext, id: string): Promise<DocumentRecord | undefined> {
  const [doc] = await ctx.data.documents([id]);
  return doc && canSee(ctx, doc) ? doc : undefined;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function speaker(segment: Pick<SegmentRecord, 'source' | 'speakerLabel'>): string {
  if (segment.source === 'mic') return 'Me';
  return segment.speakerLabel ? label(segment.speakerLabel, 80) : 'Them';
}

/** Every block (with an id) in the document, by id. */
function blocksById(doc: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { attrs?: { id?: unknown }; content?: unknown[] };
    if (typeof n.attrs?.id === 'string' && !out.has(n.attrs.id)) out.set(n.attrs.id, n as never);
    n.content?.forEach(visit);
  };
  visit(doc);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// searchMeetings
// ---------------------------------------------------------------------------------------------------------

export interface SearchMeetingsInput {
  query: string;
  /** Results to return (default 8, max 12). */
  limit?: number;
  /** Only notes or only transcripts. */
  source?: 'notes' | 'transcript' | 'all';
  /** Narrow a workspace chat to one document. */
  documentId?: string;
}

export interface Excerpt {
  /** The marker to copy into the answer. */
  cite: string;
  /** `mm:ss` into the meeting (transcript excerpts). */
  at?: string;
  speaker?: string;
  text: string;
}

export interface SearchMeetingsResult {
  documentId: string;
  title: string;
  kind: 'meeting' | 'page';
  source: 'notes' | 'transcript';
  excerpts: Excerpt[];
}

export async function searchMeetings(
  ctx: ToolContext,
  input: SearchMeetingsInput,
): Promise<{ results: SearchMeetingsResult[] } | ToolError> {
  const query = oneLine(input.query ?? '').slice(0, 500);
  if (!query) return { error: 'invalid_input', message: 'query is empty' };
  const k = Math.min(
    Math.max(Math.trunc(input.limit ?? TOOL_LIMITS.searchResults), 1),
    TOOL_LIMITS.maxSearchResults,
  );
  let scope: { documentId: string } | { workspaceId: string } =
    ctx.scope.kind === 'document'
      ? { documentId: ctx.scope.documentId }
      : { workspaceId: ctx.scope.workspaceId };
  if (input.documentId) {
    const doc = await visibleDocument(ctx, input.documentId);
    if (!doc) return notFound('Document');
    scope = { documentId: doc.id };
  }
  const sources =
    input.source === 'notes' || input.source === 'transcript' ? [input.source] : undefined;
  const hits = await ctx.data.search(actorOnly(ctx), query, {
    k,
    scope,
    ...(sources ? { sources } : {}),
  });

  // Re-check every hit against the live document row (the index can lag a permission change).
  const docs = new Map(
    (await ctx.data.documents([...new Set(hits.map((h) => h.documentId))]))
      .filter((d) => canSee(ctx, d))
      .map((d) => [d.id, d]),
  );
  const visible = hits.filter((h) => docs.has(h.documentId));

  // Per-segment / per-block excerpts so every line can be cited precisely.
  const segmentIds = visible.flatMap((h) =>
    h.ref.source === 'transcript' ? h.ref.segmentIds.slice(0, TOOL_LIMITS.excerptsPerHit) : [],
  );
  const segments = new Map((await ctx.data.segmentsByIds(segmentIds)).map((s) => [s.id, s]));
  const meetingOf = new Map<string, string | undefined>();
  for (const hit of visible) {
    if (hit.ref.source === 'transcript' && !meetingOf.has(hit.documentId)) {
      meetingOf.set(hit.documentId, (await ctx.data.meeting({ documentId: hit.documentId }))?.id);
    }
  }

  const results: SearchMeetingsResult[] = [];
  for (const hit of visible) {
    const doc = docs.get(hit.documentId)!;
    let excerpts: Excerpt[];
    if (hit.ref.source === 'transcript') {
      const meetingId = meetingOf.get(hit.documentId);
      excerpts = hit.ref.segmentIds
        .slice(0, TOOL_LIMITS.excerptsPerHit)
        .map((id) => segments.get(id))
        // A segment must belong to this document's meeting (a stale chunk could point elsewhere).
        .filter((s): s is SegmentRecord => s !== undefined && s.meetingId === meetingId)
        .map((s) => ({
          cite: segCite(s.id),
          at: clock(s.startMs),
          speaker: speaker(s),
          text: fence('excerpt', cap(s.text, TOOL_LIMITS.excerptChars), true),
        }));
    } else {
      const blocks = blocksById(doc.contentJson);
      excerpts = hit.ref.blockIds.slice(0, TOOL_LIMITS.excerptsPerHit).flatMap((id) => {
        const block = blocks.get(id);
        if (!block) return [];
        const text = oneLine(toMarkdown(block as MarkdownDoc)) || blockPlainText(block);
        return text
          ? [
              {
                cite: blockCite(id),
                text: fence('excerpt', cap(text, TOOL_LIMITS.excerptChars), true),
              },
            ]
          : [];
      });
    }
    if (excerpts.length === 0) continue;
    results.push({
      documentId: doc.id,
      title: label(doc.title),
      kind: doc.kind,
      source: hit.ref.source,
      excerpts,
    });
  }
  return { results };
}

// ---------------------------------------------------------------------------------------------------------
// getDocument
// ---------------------------------------------------------------------------------------------------------

export interface GetDocumentOutput {
  documentId: string;
  title: string;
  kind: 'meeting' | 'page';
  version: number;
  updatedAt: string;
  /** Present for meeting notes: pass it to getTranscript. */
  meetingId?: string;
  /** Notes as Markdown; each block ends with `<!-- id=<block id> -->` (cite as `[[block:<id>]]`). */
  markdown: string;
  /** The document's block ids: what the citation filter allows (read structurally, never from text). */
  blockIds: string[];
  truncated: boolean;
}

/** Keeps whole lines from the top within `maxTokens`. */
function capLines(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }
  return { text: kept.join('\n'), truncated: true };
}

export async function getDocument(
  ctx: ToolContext,
  input: { documentId: string },
): Promise<GetDocumentOutput | ToolError> {
  const doc = await visibleDocument(ctx, input.documentId);
  if (!doc) return notFound('Document');
  const markdown = toMarkdown(defuseDocText(doc.contentJson) as MarkdownDoc, {
    blockIds: true,
    includeOrigin: true,
  });
  const { text, truncated } = capLines(markdown, TOOL_LIMITS.documentTokens);
  const meeting =
    doc.kind === 'meeting' ? await ctx.data.meeting({ documentId: doc.id }) : undefined;
  return {
    documentId: doc.id,
    title: label(doc.title),
    kind: doc.kind,
    version: doc.version,
    updatedAt: doc.updatedAt.toISOString(),
    ...(meeting ? { meetingId: meeting.id } : {}),
    // The serializer's own `<!-- id=… -->` annotations stay; comments in content were defused above.
    markdown: fence('document', text || '(empty)', false, { keepComments: true }),
    blockIds: [...blocksById(doc.contentJson).keys()],
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------------------
// getTranscript
// ---------------------------------------------------------------------------------------------------------

export interface GetTranscriptInput {
  meetingId?: string;
  /** Alternative to `meetingId`: the meeting note's document id. */
  documentId?: string;
  fromMs?: number;
  toMs?: number;
}

export interface GetTranscriptOutput {
  meetingId: string;
  documentId: string;
  title: string;
  startedAt: string | null;
  /** One line per segment: `[[seg:<id>]] [mm:ss] Speaker: text`. */
  transcript: string;
  segments: number;
  /** More segments follow: call again with `fromMs` = this. */
  nextFromMs: number | null;
}

export async function getTranscript(
  ctx: ToolContext,
  input: GetTranscriptInput,
): Promise<GetTranscriptOutput | ToolError> {
  const by = input.meetingId
    ? { id: input.meetingId }
    : input.documentId
      ? { documentId: input.documentId }
      : undefined;
  if (!by) return { error: 'invalid_input', message: 'pass meetingId or documentId' };
  const meeting = await ctx.data.meeting(by);
  if (!meeting) return notFound('Meeting');
  const doc = await visibleDocument(ctx, meeting.documentId);
  if (!doc) return notFound('Meeting');

  const fromMs = Math.max(0, Math.trunc(input.fromMs ?? 0));
  const toMs = input.toMs === undefined ? undefined : Math.trunc(input.toMs);
  const rows = await ctx.data.segments(
    meeting.id,
    { fromMs, ...(toMs === undefined ? {} : { toMs }) },
    TOOL_LIMITS.transcriptSegments + 1,
  );
  const lines: string[] = [];
  let used = 0;
  let next: number | null = null;
  for (const [i, s] of rows.entries()) {
    const line = `${segCite(s.id)} [${clock(s.startMs)}] ${speaker(s)}: ${defuse(oneLine(s.text))}`;
    const cost = estimateTokens(line) + 1;
    if (i >= TOOL_LIMITS.transcriptSegments || used + cost > TOOL_LIMITS.transcriptTokens) {
      next = s.startMs;
      break;
    }
    lines.push(line);
    used += cost;
  }
  return {
    meetingId: meeting.id,
    documentId: doc.id,
    title: label(doc.title),
    startedAt: iso(meeting.startedAt),
    transcript: `<oat:transcript>\n${lines.join('\n') || '(no transcript in this range)'}\n</oat:transcript>`,
    segments: lines.length,
    nextFromMs: next,
  };
}

// ---------------------------------------------------------------------------------------------------------
// listMeetings
// ---------------------------------------------------------------------------------------------------------

export interface ListMeetingsInput {
  /** ISO 8601 date or date-time, inclusive. */
  from?: string;
  /** ISO 8601 date or date-time, exclusive. */
  to?: string;
  /** Part of an attendee's name or email. */
  attendee?: string;
  folderId?: string;
  limit?: number;
}

export interface ListedMeeting {
  documentId: string;
  meetingId: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  attendees: string[];
  folderId: string | null;
}

function parseDate(value: string | undefined): Date | undefined | null {
  if (value === undefined || value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function personLabel(p: MeetingRecord['participants'][number]): string {
  const name = label(p.name || '', 120);
  return p.email ? `${name} <${label(p.email, 254)}>` : name;
}

export async function listMeetings(
  ctx: ToolContext,
  input: ListMeetingsInput,
): Promise<{ meetings: ListedMeeting[] } | ToolError> {
  const from = parseDate(input.from);
  const to = parseDate(input.to);
  if (from === null || to === null) {
    return { error: 'invalid_input', message: 'from/to must be ISO 8601 dates' };
  }
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? TOOL_LIMITS.meetings), 1),
    TOOL_LIMITS.maxMeetings,
  );
  const attendee = input.attendee?.trim().slice(0, 200) || undefined;
  const rows = await ctx.data.listMeetings(actorOnly(ctx), {
    workspaceId: ctx.scope.workspaceId,
    limit,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(attendee ? { attendee } : {}),
    ...(input.folderId ? { folderId: input.folderId } : {}),
  });
  const meetings = rows
    .filter((r) => canSee(ctx, r.document) && r.meeting.documentId === r.document.id)
    .slice(0, limit)
    .map(({ document, meeting }) => ({
      documentId: document.id,
      meetingId: meeting.id,
      title: label(document.title),
      startedAt: iso(meeting.startedAt),
      endedAt: iso(meeting.endedAt),
      attendees: meeting.participants.slice(0, 30).map(personLabel),
      folderId: document.folderId,
    }));
  return { meetings };
}

// ---------------------------------------------------------------------------------------------------------
// updateDocument (proposal only)
// ---------------------------------------------------------------------------------------------------------

export interface UpdateDocumentInput {
  documentId: string;
  edits: TextEdit[];
  /** One line for the user: what the change does. */
  summary?: string;
}

export interface UpdateDocumentOutput {
  proposalId: string;
  status: 'pending';
  documentId: string;
  baseVersion: number;
  changes: { blockId: string; before: string; after: string }[];
  note: string;
}

export async function updateDocument(
  ctx: ToolContext,
  input: UpdateDocumentInput,
): Promise<UpdateDocumentOutput | ToolError> {
  const doc = await visibleDocument(ctx, input.documentId);
  if (!doc) return notFound('Document');
  // The document is readable, so saying it isn't editable reveals nothing new.
  if (!canEditDocument(actorOnly(ctx), doc)) {
    return { error: 'forbidden', message: 'You can read this document but not edit it.' };
  }
  const result = applyTextEdits(doc.contentJson, input.edits);
  if (!result.ok) {
    const { error } = result;
    const message =
      error.code === 'not_found'
        ? `edit ${error.editIndex + 1}: the text to find is not in the document`
        : error.code === 'ambiguous'
          ? `edit ${error.editIndex + 1}: the text to find appears ${error.matches} times; include more context`
          : `edit ${error.editIndex + 1}: ${error.message}`;
    return { error: 'invalid_input', message };
  }
  if (result.changes.length === 0) {
    return { error: 'invalid_input', message: 'the edits change nothing' };
  }
  const proposal: EditProposal = {
    id: (ctx.newId ?? (() => crypto.randomUUID()))(),
    documentId: doc.id,
    baseVersion: doc.version,
    edits: input.edits.map((e) => ({ find: e.find, replace: e.replace })),
    changes: result.changes,
    summary: oneLine(input.summary ?? '').slice(0, 300),
    status: 'pending',
  };
  ctx.onProposal?.(proposal);
  return {
    proposalId: proposal.id,
    status: 'pending',
    documentId: doc.id,
    baseVersion: doc.version,
    changes: proposal.changes.map((c) => ({
      blockId: c.blockId,
      before: fence('before', cap(c.before, TOOL_LIMITS.excerptChars), true),
      after: fence('after', cap(c.after, TOOL_LIMITS.excerptChars), true),
    })),
    note: 'Not applied yet: the user reviews this change and approves or rejects it in the app.',
  };
}
