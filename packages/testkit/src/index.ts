/** Test helpers for integration tests (`*.int.test.ts`) against the compose stack. See docs/DEV.md. */
export {
  ALLOW_REMOTE_DB_ENV,
  assertLocalDatabase,
  createTestDatabase,
  STALE_TEST_DATABASE_MS,
  sweepStaleTestDatabases,
  testDatabaseCreatedAt,
  testDatabaseName,
  TEST_DATABASE_PREFIX,
  type CreateTestDatabaseOptions,
  type TestDatabase,
} from './database.ts';
export * as testEnv from './env.ts';
export {
  createMailpit,
  extractFirstLink,
  uniqueAddress,
  type Mailpit,
  type MailpitMessage,
  type MailpitSummary,
} from './mailpit.ts';
export { waitFor, type WaitForOptions } from './wait-for.ts';
