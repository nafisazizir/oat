/**
 * `@oat/ai/tools` — the assistant's tools (6.2): plain, permission-checking functions over an
 * {@link AssistantData} port, plus the AI SDK tool set built from them. See `./tools.ts` for the rules.
 */
export { type AssistantTools, createAssistantTools } from './ai-tools.ts';
export { createDbAssistantData, type SearchFn } from './db.ts';
export {
  applyTextEdits,
  blockPlainText,
  type EditError,
  type EditResult,
  MAX_EDITS,
  MAX_FIND_CHARS,
  MAX_REPLACE_CHARS,
} from './edit.ts';
export { createMemoryAssistantData, type MemoryDataInput } from './memory.ts';
export {
  blockCite,
  canSee,
  defuse,
  type Excerpt,
  fence,
  getDocument,
  type GetDocumentOutput,
  getTranscript,
  type GetTranscriptInput,
  type GetTranscriptOutput,
  label,
  type ListedMeeting,
  listMeetings,
  type ListMeetingsInput,
  searchMeetings,
  type SearchMeetingsInput,
  type SearchMeetingsResult,
  segCite,
  TOOL_LIMITS,
  type ToolError,
  updateDocument,
  type UpdateDocumentInput,
  type UpdateDocumentOutput,
} from './tools.ts';
export {
  type AssistantData,
  type BlockChange,
  type DocumentRecord,
  type EditProposal,
  type HitRef,
  type MeetingListFilter,
  type MeetingListItem,
  type MeetingRecord,
  type ParticipantRecord,
  PROPOSAL_STATUSES,
  type ProposalStatus,
  type SearchHit,
  type SearchRequest,
  type SearchScope,
  type SegmentRecord,
  type TextEdit,
  type ToolContext,
  type ToolScope,
} from './types.ts';
