/**
 * Shapes shared by the assistant tools (6.2). The tools are plain functions over an {@link AssistantData}
 * port — `createDbAssistantData(db, …)` in production, `createMemoryAssistantData(…)` in evals and unit
 * tests — so the interactive chat (AI SDK tool loop, D-7) and later background agents (eve, M8) call the
 * same code. The port only loads rows; every permission decision is made by the tools with `@oat/core`.
 */
import type { DocumentAccess, DocumentKind, PermissionContext, TranscriptSource } from '@oat/core';

/** A document row as the tools see it (access fields + what they render). */
export interface DocumentRecord extends DocumentAccess {
  readonly id: string;
  readonly folderId: string | null;
  readonly kind: DocumentKind;
  readonly title: string;
  /** Sync version (D-19): the base version of an edit proposal. */
  readonly version: number;
  /** TipTap JSON (canonical). */
  readonly contentJson: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A user as the tools may show them: who recorded a meeting. */
export interface UserRecord {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

export interface ParticipantRecord {
  readonly name: string;
  readonly email: string | null;
}

export interface MeetingRecord {
  readonly id: string;
  readonly documentId: string;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly platform: string | null;
  readonly participants: readonly ParticipantRecord[];
}

export interface SegmentRecord {
  readonly id: string;
  readonly meetingId: string;
  readonly source: TranscriptSource;
  readonly speakerLabel: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** Where a search hit points (same shape as `@oat/indexing`'s `ChunkRef`). */
export type HitRef =
  | { source: 'notes'; blockIds: string[] }
  | { source: 'transcript'; segmentIds: string[]; startMs: number; endMs: number };

/** A retrieval hit (structurally a subset of `@oat/indexing`'s `ChunkHit`). */
export interface SearchHit {
  documentId: string;
  workspaceId: string;
  documentTitle: string;
  documentKind: DocumentKind;
  text: string;
  ref: HitRef;
  score: number;
}

export type SearchScope = { documentId: string } | { workspaceId: string };

export interface SearchRequest {
  k: number;
  scope: SearchScope;
  sources?: readonly ('notes' | 'transcript')[];
}

export interface MeetingListFilter {
  workspaceId: string;
  /** Meetings that started (or, without a start time, were created) at or after this instant. */
  from?: Date;
  /** …and before this instant. */
  to?: Date;
  /** Case-insensitive substring of a participant's name or email. */
  attendee?: string;
  folderId?: string;
  limit: number;
}

export interface MeetingListItem {
  document: Omit<DocumentRecord, 'contentJson'>;
  meeting: MeetingRecord;
}

/**
 * Data access for the tools. Implementations may pre-filter by permission (the SQL one does, so limits
 * hold), but the tools re-check every row with `@oat/core` before it reaches the model.
 */
export interface AssistantData {
  /** Permission-safe retrieval (`searchChunks` in production). */
  search(
    permissions: PermissionContext,
    query: string,
    request: SearchRequest,
  ): Promise<SearchHit[]>;
  /** Documents by id (missing ids are left out). Includes trashed rows; the tools filter them. */
  documents(ids: readonly string[]): Promise<DocumentRecord[]>;
  meeting(by: { id: string } | { documentId: string }): Promise<MeetingRecord | undefined>;
  /** Final segments of a meeting in time order, optionally within `[fromMs, toMs)`, at most `limit`. */
  segments(
    meetingId: string,
    range: { fromMs?: number; toMs?: number },
    limit: number,
  ): Promise<SegmentRecord[]>;
  /** Segments by id (any meeting; the tools check each one's document). */
  segmentsByIds(ids: readonly string[]): Promise<SegmentRecord[]>;
  /** Users by id (missing ids are left out). Only asked for owners of documents the actor may read. */
  users(ids: readonly string[]): Promise<UserRecord[]>;
  /** Meetings in a workspace that the actor may read, newest first. */
  listMeetings(
    permissions: PermissionContext,
    filter: MeetingListFilter,
  ): Promise<MeetingListItem[]>;
}

/** What a chat may see: one document, or one workspace. */
export type ToolScope =
  | { kind: 'document'; workspaceId: string; documentId: string }
  | { kind: 'workspace'; workspaceId: string };

/** A find/replace edit inside the document's text (exactly one match required). */
export interface TextEdit {
  find: string;
  replace: string;
}

export interface BlockChange {
  blockId: string;
  before: string;
  after: string;
}

export const PROPOSAL_STATUSES = ['pending', 'applied', 'rejected', 'stale', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * A pending document edit. Never written by the tool: the user approves it, and the server re-applies
 * `edits` to the document at `baseVersion` (409 when it has moved on).
 */
export interface EditProposal {
  id: string;
  documentId: string;
  baseVersion: number;
  edits: TextEdit[];
  changes: BlockChange[];
  summary: string;
  status: ProposalStatus;
}

export interface ToolContext {
  /** The actor. Share tokens are ignored: a link grants reading one page, not asking about it. */
  permissions: PermissionContext;
  data: AssistantData;
  scope: ToolScope;
  /** Receives proposals made by `updateDocument` (the chat route persists them with the message). */
  onProposal?: (proposal: EditProposal) => void;
  /** Proposal ids (default `crypto.randomUUID`). */
  newId?: () => string;
}
