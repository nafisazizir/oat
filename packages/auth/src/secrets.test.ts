import { createDb } from '@oat/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type AuthConfig, DEV_AUTH_SECRET } from './config.ts';
import { decryptSecret, encryptSecret, type SecretSource, secretSourceFromEnv } from './secrets.ts';
import { createAuth } from './server.ts';

const source = (secret: string): SecretSource => ({
  $context: Promise.resolve({ secretConfig: secret }),
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips, never stores the plaintext and uses a fresh nonce each time', async () => {
    const auth = source('a'.repeat(40));
    const token = 'ntn_mock_0123456789abcdef';
    const a = await encryptSecret(auth, token);
    const b = await encryptSecret(auth, token);
    expect(a).not.toContain(token);
    expect(a).not.toBe(b);
    expect(await decryptSecret(auth, a)).toBe(token);
  });

  it('fails with another secret', async () => {
    const encrypted = await encryptSecret(source('a'.repeat(40)), 'secret');
    await expect(decryptSecret(source('b'.repeat(40)), encrypted)).rejects.toThrow();
  });
});

describe('secretSourceFromEnv (8.3: decrypt without an auth instance)', () => {
  const config = (secret: string): AuthConfig => ({
    secret,
    baseURL: 'http://localhost:3000',
    trustedOrigins: [],
    smtp: { host: 'localhost', port: 11025, from: 'Oat <no-reply@oat.localhost>' },
    google: { issuer: 'http://localhost:18089/google', clientId: 'x', clientSecret: 'x' },
    maxTeamWorkspaces: 3,
    production: false,
  });
  // Never connects: building the auth context doesn't query the database.
  const db = createDb('postgres://oat:oat@127.0.0.1:1/never');
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads what a real auth instance encrypted with BETTER_AUTH_SECRET, and back', async () => {
    vi.stubEnv('BETTER_AUTH_SECRETS', '');
    const auth = createAuth({ db, config: config(DEV_AUTH_SECRET) });
    const env = { BETTER_AUTH_SECRET: DEV_AUTH_SECRET };
    const fromAuth = await encryptSecret(auth, 'ntn_mock_a');
    expect(await decryptSecret(secretSourceFromEnv(env), fromAuth)).toBe('ntn_mock_a');
    const fromEnv = await encryptSecret(secretSourceFromEnv(env), 'ntn_mock_b');
    expect(await decryptSecret(auth, fromEnv)).toBe('ntn_mock_b');
  });

  it('follows BETTER_AUTH_SECRETS rotation like Better Auth (current first, legacy kept)', async () => {
    const legacy = 'l'.repeat(40);
    const before = await encryptSecret(secretSourceFromEnv({ BETTER_AUTH_SECRET: legacy }), 'old');
    const secrets = `2:${'n'.repeat(40)}, 1:${'o'.repeat(40)}`;
    vi.stubEnv('BETTER_AUTH_SECRETS', secrets);
    const auth = createAuth({ db, config: config(legacy) });
    const env = { BETTER_AUTH_SECRET: legacy, BETTER_AUTH_SECRETS: secrets };
    const now = await encryptSecret(auth, 'new');
    expect(await decryptSecret(secretSourceFromEnv(env), now)).toBe('new');
    expect(await decryptSecret(secretSourceFromEnv(env), before)).toBe('old');
    expect(await decryptSecret(auth, before)).toBe('old');
    expect(await decryptSecret(auth, await encryptSecret(secretSourceFromEnv(env), 'x'))).toBe('x');
  });

  it('refuses a short secret or a malformed BETTER_AUTH_SECRETS', () => {
    expect(() => secretSourceFromEnv({ BETTER_AUTH_SECRET: 'short' })).toThrow(/32/);
    expect(() =>
      secretSourceFromEnv({ BETTER_AUTH_SECRET: DEV_AUTH_SECRET, BETTER_AUTH_SECRETS: 'nope' }),
    ).toThrow(/BETTER_AUTH_SECRETS/);
  });
});
