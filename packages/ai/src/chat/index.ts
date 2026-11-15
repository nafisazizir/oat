/**
 * `@oat/ai/chat` — the grounded assistant (6.2): system instructions, the tool loop, citation validation and
 * the document-chat context. The HTTP layer (threads, persistence, approvals) lives in `apps/web`.
 */
export {
  type Citation,
  CitationFilter,
  type CitationKind,
  CITATION_MARKER,
  CitationRegistry,
  CitationStats,
  citationTransform,
  extractCitations,
  filterCitations,
} from './citations.ts';
export { buildChatInstructions, type ChatInstructionsInput } from './prompt.ts';
export {
  CHAT_LIMITS,
  completeParts,
  type DocumentContext,
  type DocumentContextOptions,
  loadDocumentContext,
  registerHistory,
  streamAssistant,
  type StreamAssistantOptions,
  trimHistory,
} from './run.ts';
