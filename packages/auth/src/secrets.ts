/**
 * Encrypt provider credentials that don't live on a Better Auth `account` row (8.1: Notion's OAuth token on
 * the `integration` row) exactly like Better Auth encrypts OAuth tokens (`account.encryptOAuthTokens`, 7.4):
 * `symmetricEncrypt` (XChaCha20-Poly1305) with the auth instance's secret config, so `BETTER_AUTH_SECRETS`
 * rotation (versioned, newest first) applies to these values too. Server-only.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

import type { Auth } from './server.ts';

/** What the helpers need from an auth instance (its lazily built context carries the secret config). */
export type SecretSource = Pick<Auth, '$context'>;

export async function encryptSecret(auth: SecretSource, plaintext: string): Promise<string> {
  const { secretConfig } = await auth.$context;
  return symmetricEncrypt({ key: secretConfig, data: plaintext });
}

/** Throws if the value was encrypted with a secret that is no longer configured (or was tampered with). */
export async function decryptSecret(auth: SecretSource, ciphertext: string): Promise<string> {
  const { secretConfig } = await auth.$context;
  return symmetricDecrypt({ key: secretConfig, data: ciphertext });
}
