import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, type SecretSource } from './secrets.ts';

const source = (secret: string) =>
  ({ $context: Promise.resolve({ secretConfig: secret }) }) as unknown as SecretSource;

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
