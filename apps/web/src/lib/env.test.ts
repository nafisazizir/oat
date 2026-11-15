import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { desktopDevHandoff, EnvError, integrationModes, parseEnv } from './env';

const example = parseDotenv(
  readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('parseEnv', () => {
  it('accepts the .env.example defaults as-is (the app boots on a fresh checkout)', () => {
    const env = parseEnv(example);
    expect(env.DATABASE_URL).toBe('postgres://oat:oat@localhost:54329/oat');
    expect(env.SMTP_PORT).toBe(11025);
    expect(env.NODE_ENV).toBe('development');
  });

  it('treats blank keys as unset', () => {
    const env = parseEnv(example);
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.AI_GATEWAY_BASE_URL).toBeUndefined();
    expect(env.DEEPGRAM_API_KEY).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
  });

  it('names every missing or malformed variable, without echoing values', () => {
    const secret = 'not-a-url-but-maybe-a-secret';
    const run = () =>
      parseEnv({ ...example, DATABASE_URL: undefined, MOCKS_URL: secret, SMTP_PORT: 'abc' });
    expect(run).toThrow(EnvError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('MOCKS_URL');
      expect(message).toContain('SMTP_PORT');
      expect(message).not.toContain(secret);
    }
  });

  it('rejects a malformed optional base URL', () => {
    expect(() => parseEnv({ ...example, DEEPGRAM_BASE_URL: 'nope' })).toThrow(/DEEPGRAM_BASE_URL/);
  });
});

describe('integrationModes', () => {
  it('uses the mocks by default', () => {
    expect(integrationModes(parseEnv(example))).toEqual({
      ai: 'mock',
      stt: 'mock',
      oauth: 'mock',
      calendar: 'mock',
    });
  });

  it('switches to the real provider when a key or the real issuer is set', () => {
    const env = parseEnv({
      ...example,
      AI_GATEWAY_API_KEY: 'k',
      DEEPGRAM_API_KEY: 'k',
      OAUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
    });
    expect(integrationModes(env)).toEqual({
      ai: 'real',
      stt: 'real',
      oauth: 'real',
      calendar: 'real',
    });
  });
});

describe('desktopDevHandoff', () => {
  it('offers the copy-link fallback only outside production', () => {
    expect(desktopDevHandoff(parseEnv(example))).toBe(true);
    expect(desktopDevHandoff(parseEnv({ ...example, OAT_DESKTOP_DEV_HANDOFF: '0' }))).toBe(false);
    expect(desktopDevHandoff(parseEnv({ ...example, NODE_ENV: 'production' }))).toBe(false);
    expect(desktopDevHandoff({ NODE_ENV: 'production', OAT_DESKTOP_DEV_HANDOFF: '1' })).toBe(false);
  });

  it('refuses OAT_DESKTOP_DEV_HANDOFF=1 in production', () => {
    expect(() =>
      parseEnv({ ...example, NODE_ENV: 'production', OAT_DESKTOP_DEV_HANDOFF: '1' }),
    ).toThrow(/OAT_DESKTOP_DEV_HANDOFF/);
    expect(() => parseEnv({ ...example, OAT_DESKTOP_DEV_HANDOFF: 'yes' })).toThrow(
      /OAT_DESKTOP_DEV_HANDOFF/,
    );
  });
});
