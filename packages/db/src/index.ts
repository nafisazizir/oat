/** Drizzle schema (Postgres), migrations and shared row types. */
export const packageName = '@oat/db';

export {
  createDb,
  migrate,
  MIGRATIONS_FOLDER,
  type CreateDbOptions,
  type Db,
  type Schema,
} from './client.ts';
export { newId, newToken, idTimestamp, UUID_V7 } from './id.ts';
export { organizationOptions, organizationSchema } from './auth-mapping.ts';
export {
  decodeCursor,
  encodeCursor,
  readAllChanges,
  readChanges,
  type Change,
  type ChangePage,
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
export * as schema from './schema/index.ts';
export * from './schema/index.ts';
export type * from './rows.ts';
