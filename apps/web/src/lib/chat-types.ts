/**
 * Wire shapes of the assistant API (`/api/chat…`, 6.2/6.3). The chat UI (6.4) consumes these; the stream
 * itself is the AI SDK UI message stream. Plain types only: dates are ISO strings.
 */
import type { UIMessage } from 'ai';

export type ChatScope =
  { kind: 'document'; documentId: string } | { kind: 'workspace'; workspaceId: string };

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'failed';

/** An `updateDocument` proposal as the user reviews it. */
export type ChatProposal = {
  id: string;
  documentId: string;
  baseVersion: number;
  summary: string;
  changes: { blockId: string; before: string; after: string }[];
  status: ProposalStatus;
  /** The document version the approval produced. */
  appliedVersion?: number;
};

export type ChatCitation = { kind: 'seg' | 'block'; id: string };

/** Sent as message metadata on the stream's `start` part, and stored with assistant messages. */
export type ChatMessageMetadata = {
  threadId: string;
  /** The persisted id of the user message this answers. */
  userMessageId?: string;
  /** Present on stored assistant messages. */
  citations?: ChatCitation[];
  proposals?: ChatProposal[];
};

export type ChatUIMessage = UIMessage<ChatMessageMetadata>;

export type ChatThreadSummary = {
  id: string;
  workspaceId: string;
  scope: 'document' | 'workspace';
  documentId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * A citation resolved for display (6.4), re-checked against the reader's current access. A citation that is
 * missing from {@link ChatSources.citations} is no longer available (deleted, or no longer readable).
 */
export type ResolvedCitation =
  | {
      kind: 'seg';
      id: string;
      documentId: string;
      title: string;
      /** Milliseconds into the recording. */
      startMs: number;
      speaker: string;
      /** The segment's text (capped). */
      text: string;
    }
  | { kind: 'block'; id: string; documentId: string; title: string; text: string };

/** What a thread's citations and proposals point at, keyed `seg:<id>` / `block:<id>` and by document id. */
export type ChatSources = {
  citations: Record<string, ResolvedCitation>;
  /** Titles of the documents proposals target (only those the reader can still read). */
  documents: Record<string, { title: string }>;
};

export type ChatThreadDetail = {
  thread: ChatThreadSummary;
  messages: (ChatUIMessage & { createdAt: string })[];
  sources: ChatSources;
};

export type ProposalDecisionInput = { decision: 'approve' | 'reject' };

export type ProposalDecisionResult = {
  proposal: ChatProposal;
  /** The updated document (approve). */
  document?: { id: string; version: number };
};
