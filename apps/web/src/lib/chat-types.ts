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

export type ChatThreadDetail = {
  thread: ChatThreadSummary;
  messages: (ChatUIMessage & { createdAt: string })[];
};

export type ProposalDecisionInput = { decision: 'approve' | 'reject' };

export type ProposalDecisionResult = {
  proposal: ChatProposal;
  /** The updated document (approve). */
  document?: { id: string; version: number };
};
