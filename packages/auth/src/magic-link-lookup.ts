/**
 * Read-only lookup of a pending magic link, for the confirm page to show which address it signs in
 * (so nobody presses "Continue" on a link for an account they didn't expect). Never consumes the token.
 */
import { createHash } from 'node:crypto';

import { type Db, verification } from '@oat/db';
import { and, eq, gt } from 'drizzle-orm';

/**
 * How Better Auth stores a magic-link token with `storeToken: 'hashed'` (server.ts): SHA-256,
 * base64url without padding, under the identifier `magic-link:<hash>`. Checked by an int test.
 */
export function magicLinkIdentifier(token: string): string {
  return `magic-link:${createHash('sha256').update(token).digest('base64url')}`;
}

/** The email a still-valid, unused magic-link token was sent to, or `undefined`. */
export async function peekMagicLinkEmail(db: Db, token: string): Promise<string | undefined> {
  if (!token || token.length > 512) return undefined;
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, magicLinkIdentifier(token)),
        gt(verification.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as { type?: unknown; email?: unknown };
    return parsed.type === 'magic-link' && typeof parsed.email === 'string'
      ? parsed.email
      : undefined;
  } catch {
    return undefined;
  }
}
