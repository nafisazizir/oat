/**
 * Encrypt provider credentials that don't live on a Better Auth `account` row (8.1: Notion's OAuth token on
 * the `integration` row) exactly like Better Auth encrypts OAuth tokens (`account.encryptOAuthTokens`, 7.4):
 * `symmetricEncrypt` (XChaCha20-Poly1305) with the auth instance's secret config, so `BETTER_AUTH_SECRETS`
 * rotation (versioned, newest first) applies to these values too. Server-only.
 */
import { type SecretConfig, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

/**
 * What the helpers need: an auth instance (its lazily built context carries the secret config), or
 * {@link secretSourceFromEnv} where no auth instance is wanted (the background agents, 8.3).
 */
export type SecretSource = {
  readonly $context: PromiseLike<{ secretConfig: string | SecretConfig }>;
};

export async function encryptSecret(auth: SecretSource, plaintext: string): Promise<string> {
  const { secretConfig } = await auth.$context;
  return symmetricEncrypt({ key: secretConfig, data: plaintext });
}

/** Throws if the value was encrypted with a secret that is no longer configured (or was tampered with). */
export async function decryptSecret(auth: SecretSource, ciphertext: string): Promise<string> {
  const { secretConfig } = await auth.$context;
  return symmetricDecrypt({ key: secretConfig, data: ciphertext });
}

/** Better Auth's placeholder secret: never a real legacy key. */
const BETTER_AUTH_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

/**
 * The secret config Better Auth builds for `createAuth` (better-auth 1.7 `context/create-context`): with
 * `BETTER_AUTH_SECRETS` (`"<version>:<secret>,…"`, current first) a versioned key map plus
 * `BETTER_AUTH_SECRET` as the legacy key; otherwise `BETTER_AUTH_SECRET` alone. Kept in step with Better
 * Auth by `auth.int.test.ts` (a value encrypted by a real auth instance must decrypt here and back).
 */
export function secretConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | SecretConfig {
  const legacy = env.BETTER_AUTH_SECRET?.trim() || env.AUTH_SECRET?.trim() || '';
  const versioned = env.BETTER_AUTH_SECRETS?.trim();
  if (!versioned) {
    if (legacy.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
    return legacy;
  }
  const keys = new Map<number, string>();
  let currentVersion: number | undefined;
  for (const [index, raw] of versioned.split(',').entries()) {
    const entry = raw.trim();
    const colon = entry.indexOf(':');
    const version = Number(entry.slice(0, colon));
    const value = entry.slice(colon + 1).trim();
    if (colon === -1 || !Number.isInteger(version) || version < 0 || !value || keys.has(version)) {
      throw new Error(`Invalid BETTER_AUTH_SECRETS entry at position ${index + 1}`);
    }
    keys.set(version, value);
    currentVersion ??= version;
  }
  return {
    keys,
    currentVersion: currentVersion!,
    legacySecret: legacy && legacy !== BETTER_AUTH_DEFAULT_SECRET ? legacy : undefined,
  };
}

/** A {@link SecretSource} from the environment alone: decrypts what the web app's auth instance encrypted. */
export function secretSourceFromEnv(
  env: Record<string, string | undefined> = process.env,
): SecretSource {
  const secretConfig = secretConfigFromEnv(env);
  return { $context: Promise.resolve({ secretConfig }) };
}
