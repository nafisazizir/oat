/**
 * `@oat/local-store`: the desktop's disposable SQLite cache + outbox (D-19, task 2.6). Node only
 * (`node:sqlite`, built into Node ≥ 22.13 and Electron 45's Node 24: no native module to rebuild).
 */
export const packageName = '@oat/local-store';

export { AudioIndex } from './audio-index.ts';
export {
  InMemoryTranscriptJobStore,
  type RecordingRecovery,
  type RecoveredPart,
  type TranscriptJob,
  type TranscriptJobFilter,
  type TranscriptJobPatch,
  type TranscriptJobReason,
  type TranscriptJobStatus,
  type TranscriptJobStore,
} from './transcript-jobs.ts';
export { AUDIO_MIGRATIONS, MIGRATIONS, OUTBOX_TABLES, SCHEMA_VERSION } from './migrations.ts';
export {
  deleteDatabaseFiles,
  isCorruption,
  isTransient,
  LocalStoreUnavailableError,
  openDatabase,
  type OpenResult,
  type WipeReason,
} from './open.ts';
export {
  CONFLICT_SUFFIX,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  LocalStore,
  stripConflictSuffix,
  type LocalConflict,
  type LocalDocument,
  type LocalMeeting,
  type LocalMeetingNote,
  type LocalParticipant,
  type LocalSegment,
  type LocalStoreOptions,
  type LocalWorkspace,
  type OutboxEntry,
  type OutboxTable,
  type PushOutcome,
  type SearchHit,
} from './store.ts';
export {
  SyncEngine,
  type SyncEngineOptions,
  type SyncState,
  type SyncStatus,
  type SyncTransport,
  SyncTransportError,
} from './sync-engine.ts';
export { uuidv7 } from './uuid.ts';
