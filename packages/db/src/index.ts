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
export { decodeCursor, encodeCursor, readChanges, type Change, type ChangePage } from './sync.ts';
export * as schema from './schema/index.ts';
export * from './schema/index.ts';
export type * from './rows.ts';
