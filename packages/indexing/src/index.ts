/**
 * Retrieval indexing (6.1, SPEC §6 `chunk`): chunkers for notes and transcripts, the indexer that embeds new
 * chunks into pgvector, the Redis-backed index queue + change-log-following worker, backfill, and
 * `searchChunks` (permission-filtered retrieval with citation refs). Details: docs/tasks/6.1-embeddings.md.
 */
export {
  type ExtractedActionItem,
  extractActionItems,
  resolveOwners,
  syncActionItems,
  type SyncActionItemsResult,
} from './action-items.ts';
export { backfill, type BackfillOptions, type BackfillTotals } from './backfill.ts';
export { INDEXED_TABLES, jobsForChanges } from './changes.ts';
export { chunkNotes, CONTEXT_SEPARATOR, type NotesChunkOptions } from './chunk-notes.ts';
export {
  chunkTranscript,
  orderSegments,
  speakerName,
  type TranscriptChunkOptions,
} from './chunk-transcript.ts';
export {
  DEFAULT_QUEUE_PREFIX,
  DEFAULT_REDIS_URL,
  indexingConfig,
  type IndexingConfig,
} from './env.ts';
export {
  draftChunks,
  embedTexts,
  indexDocument,
  type IndexerDeps,
  indexMeeting,
  type IndexResult,
  modelKey,
} from './indexer.ts';
export {
  type ClaimedJob,
  connectRedis,
  createIndexQueue,
  type IndexJob,
  type IndexQueue,
  type IndexQueueOptions,
  jobKey,
  type Lock,
  parseJobKey,
  type QueueStats,
  type Redis,
} from './queue.ts';
export {
  type ChunkHit,
  type ChunkRef,
  chunkTextFtsRank,
  readableChunkFilter,
  type SearchContext,
  searchChunks,
  type SearchOptions,
  type SearchScope,
} from './retrieval.ts';
export { chunkHash, estimateTokens, splitLongText } from './text.ts';
export type { ChunkDraft, SegmentInput } from './types.ts';
export {
  createIndexWorker,
  type IndexWorker,
  type IndexWorkerOptions,
  type JobResult,
  runJob,
  type WorkerLogger,
} from './worker.ts';
