import { describe, expect, it } from 'vitest';
import {
  adminDatabaseUrl,
  databaseUrl,
  DEFAULT_DATABASE_URL,
  mailpitUrl,
  mocksUrl,
  smtpConfig,
} from './env.ts';

describe('testkit env', () => {
  it('defaults to the compose ports', () => {
    expect(databaseUrl({})).toBe(DEFAULT_DATABASE_URL);
    expect(adminDatabaseUrl({})).toBe('postgres://oat:oat@localhost:54329/postgres');
    expect(mailpitUrl({})).toBe('http://localhost:18025');
    expect(mocksUrl({})).toBe('http://localhost:14010');
    expect(smtpConfig({})).toEqual({ host: 'localhost', port: 11025 });
  });

  it('treats blank values as unset', () => {
    expect(databaseUrl({ DATABASE_URL: '  ' })).toBe(DEFAULT_DATABASE_URL);
    expect(mocksUrl({ MOCKS_URL: '' })).toBe('http://localhost:14010');
  });

  it('derives the admin URL from DATABASE_URL, keeping credentials and query', () => {
    expect(adminDatabaseUrl({ DATABASE_URL: 'postgres://u:p@db:5432/app?sslmode=disable' })).toBe(
      'postgres://u:p@db:5432/postgres?sslmode=disable',
    );
  });

  it('prefers an explicit OAT_DATABASE_ADMIN_URL', () => {
    expect(
      adminDatabaseUrl({
        DATABASE_URL: 'postgres://u:p@db/app',
        OAT_DATABASE_ADMIN_URL: 'postgres://root:r@db/admin',
      }),
    ).toBe('postgres://root:r@db/admin');
  });

  it('strips trailing slashes from service URLs', () => {
    expect(mailpitUrl({ MAILPIT_URL: 'http://mail:8025/' })).toBe('http://mail:8025');
  });

  it('rejects a bad SMTP_PORT', () => {
    expect(() => smtpConfig({ SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
  });
});
