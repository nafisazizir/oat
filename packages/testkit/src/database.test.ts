import { describe, expect, it } from 'vitest';
import {
  assertLocalDatabase,
  createTestDatabase,
  sweepStaleTestDatabases,
  testDatabaseCreatedAt,
  testDatabaseName,
} from './database.ts';

describe('testDatabaseName', () => {
  it('is a safe, unique identifier that encodes its creation time', () => {
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    const name = testDatabaseName(now);
    expect(name).toMatch(/^oat_test_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(name.length).toBeLessThan(63); // Postgres identifier limit
    expect(testDatabaseCreatedAt(name)).toBe(now);
    expect(testDatabaseName(now)).not.toBe(name);
  });

  it('testDatabaseCreatedAt ignores names that are not test databases', () => {
    expect(testDatabaseCreatedAt('oat')).toBeUndefined();
    expect(testDatabaseCreatedAt('oat_test_')).toBeUndefined();
    expect(testDatabaseCreatedAt('oat_test_abc')).toBeUndefined();
    expect(testDatabaseCreatedAt('oat_test_x"y_00')).toBeUndefined();
  });
});

describe('assertLocalDatabase', () => {
  it('allows loopback hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() =>
        assertLocalDatabase(`postgres://oat:oat@${host}:54329/postgres`, {}),
      ).not.toThrow();
    }
  });

  it('refuses other hosts unless explicitly allowed', () => {
    const neon = 'postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb';
    expect(() => assertLocalDatabase(neon, {})).toThrow(/non-local host "ep-cool-123/);
    expect(() => assertLocalDatabase(neon, { OAT_TESTKIT_ALLOW_REMOTE_DB: 'true' })).toThrow();
    expect(() => assertLocalDatabase(neon, { OAT_TESTKIT_ALLOW_REMOTE_DB: '1' })).not.toThrow();
  });

  it('guards createTestDatabase and the sweeper before connecting', async () => {
    const adminUrl = 'postgres://u:p@db.example.com/postgres';
    await expect(createTestDatabase({ adminUrl })).rejects.toThrow(/non-local host/);
    await expect(sweepStaleTestDatabases({ adminUrl })).rejects.toThrow(/non-local host/);
  });
});
