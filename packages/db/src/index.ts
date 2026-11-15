/** Drizzle schema (Postgres), migrations and shared row types. */
export const packageName = '@oat/db';

export {
  createDb,
  migrate,
  MIGRATIONS_FOLDER,
  APP_SESSION_TIMEOUTS,
  sessionTimeoutsFromEnv,
  type CreateDbOptions,
  type Db,
  type SessionTimeouts,
  type Schema,
} from './client.ts';
export { newId, newToken, idTimestamp, UUID_V7 } from './id.ts';
export { organizationOptions, organizationSchema } from './auth-mapping.ts';
export {
  decodeCursor,
  encodeCursor,
  hasHeldBackChanges,
  headCursor,
  longTransactions,
  readAllChanges,
  readChanges,
  type Change,
  type ChangePage,
  type LongTransaction,
} from './sync.ts';
export {
  upsertBuiltinTemplates,
  type BuiltinTemplateRow,
  type UpsertBuiltinsResult,
} from './templates.ts';
export {
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  parseSearchQuery,
  searchDocuments,
  searchSegments,
  toSafeHighlight,
  type DocumentSearchHit,
  type ParsedQuery,
  type SearchPage,
  type SearchResult,
  type SearchScope,
  type SegmentSearchHit,
} from './search.ts';
export {
  ACTION_ITEM_DUE_FILTERS,
  ACTION_ITEM_SCOPES,
  ACTION_ITEM_STATUSES,
  type ActionItemDraft,
  type ActionItemDueFilter,
  type ActionItemListRow,
  type ActionItemQuery,
  type ActionItemScope,
  type ActionItemStatus,
  getActionItem,
  listActionItems,
  MAX_ACTION_ITEM_TEXT,
  replaceDocumentActionItems,
  type ReplaceActionItemsResult,
} from './action-items.ts';
export {
  getUserProfile,
  normalizeProfileInput,
  profileAboutMe,
  saveUserProfile,
  type UserProfile,
  type UserProfileInput,
} from './profile.ts';
export * as schema from './schema/index.ts';
export * from './schema/index.ts';
export type * from './rows.ts';
