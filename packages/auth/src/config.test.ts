import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { AuthConfigError, authConfigFromEnv, DEV_AUTH_SECRET } from './config.ts';

const devEnv = {
  BETTER_AUTH_SECRET: DEV_AUTH_SECRET,
  BETTER_AUTH_URL: 'http://localhost:3000/',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '11025',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  SMTP_FROM: 'Oat <no-reply@oat.localhost>',
  OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google/',
  OAUTH_GOOGLE_CLIENT_ID: 'oat-dev',
  OAUTH_GOOGLE_CLIENT_SECRET: 'oat-dev-secret',
};

describe('authConfigFromEnv', () => {
  it('accepts .env.example as-is, whose secret is the refused-in-production dev secret', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const config = authConfigFromEnv(example);
    expect(config.secret).toBe(DEV_AUTH_SECRET);
    expect(config.baseURL).toBe('http://localhost:3000');
    expect(config.google.issuer).toBe('http://localhost:18089/google');
  });

  it('parses the .env.example defaults (blank SMTP credentials = none)', () => {
    const config = authConfigFromEnv(devEnv);
    expect(config).toEqual({
      secret: DEV_AUTH_SECRET,
      baseURL: 'http://localhost:3000',
      trustedOrigins: [],
      smtp: { host: 'localhost', port: 11025, from: 'Oat <no-reply@oat.localhost>' },
      google: {
        issuer: 'http://localhost:18089/google',
        clientId: 'oat-dev',
        clientSecret: 'oat-dev-secret',
      },
      maxTeamWorkspaces: 20,
      production: false,
    });
  });

  it('reads REDIS_URL and the team workspace cap', () => {
    const config = authConfigFromEnv({
      ...devEnv,
      REDIS_URL: 'redis://localhost:63790',
      AUTH_MAX_TEAM_WORKSPACES: '5',
    });
    expect(config).toMatchObject({ redisUrl: 'redis://localhost:63790', maxTeamWorkspaces: 5 });
    expect(() => authConfigFromEnv({ ...devEnv, AUTH_MAX_TEAM_WORKSPACES: 'lots' })).toThrow(
      /AUTH_MAX_TEAM_WORKSPACES/,
    );
  });

  it('reads extra trusted origins and SMTP credentials', () => {
    const config = authConfigFromEnv({
      ...devEnv,
      BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3107/, oat://app',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
    });
    expect(config.trustedOrigins).toEqual(['http://localhost:3107', 'oat://app']);
    expect(config.smtp).toMatchObject({ user: 'u', password: 'p' });
  });

  it('names missing variables without echoing values', () => {
    const fn = () =>
      authConfigFromEnv({ ...devEnv, BETTER_AUTH_SECRET: 'short-secret', SMTP_HOST: undefined });
    expect(fn).toThrow(AuthConfigError);
    expect(fn).toThrow(/BETTER_AUTH_SECRET/);
    expect(fn).toThrow(/SMTP_HOST/);
    expect(fn).not.toThrow(/short-secret/);
  });

  describe('production', () => {
    const publicProd = {
      ...devEnv,
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://oat.example',
      BETTER_AUTH_SECRET: 'x'.repeat(48),
      OAUTH_GOOGLE_ISSUER: 'https://accounts.google.com',
    };

    it('accepts https URLs with a real secret', () => {
      expect(authConfigFromEnv(publicProd).production).toBe(true);
    });

    it.each([
      [{ BETTER_AUTH_SECRET: DEV_AUTH_SECRET }, /development default/],
      [{ BETTER_AUTH_URL: 'http://oat.example' }, /BETTER_AUTH_URL must use https/],
      [{ OAUTH_GOOGLE_ISSUER: 'http://idp.example' }, /OAUTH_GOOGLE_ISSUER must use https/],
    ])('refuses %j', (override, message) => {
      expect(() => authConfigFromEnv({ ...publicProd, ...override })).toThrow(message);
    });

    it('allows a production build served on loopback (pnpm dev:app) with dev values', () => {
      const local = authConfigFromEnv({ ...devEnv, NODE_ENV: 'production' });
      expect(local).toMatchObject({ production: true, baseURL: 'http://localhost:3000' });
    });
  });
});
