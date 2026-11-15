/**
 * Better Auth plugin for the desktop sign-in hand-off (task 1.8; flow in `desktop-link.ts`).
 *
 * - `POST /api/auth/desktop/code` (signed-in browser, cookie session only; bearer is refused; Better
 *   Auth's origin check applies):
 *   `{ state, challenge }` → stores a one-time code (hashed, 2 minutes, bound to the user and the PKCE
 *   challenge) → `{ redirectUrl: "oat://auth?code=…&state=…" }`.
 * - `POST /api/auth/desktop/token` (desktop main process, no cookies): `{ code, verifier }` → consumes
 *   the code atomically, checks S256(verifier) = challenge, creates a **new** session for the desktop
 *   (its own row, so signing out on one side doesn't sign the other out) → the signed token comes back
 *   in the `set-auth-token` header (bearer plugin) and the body has the user.
 *
 * Every failure of the exchange is the same 400 `invalid_grant`, so the endpoint doesn't tell an
 * unknown code from a used, expired or PKCE-mismatched one.
 */
import { type Db, newId, verification } from '@oat/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';

import {
  DESKTOP_CODE_ENDPOINT,
  DESKTOP_TOKEN_ENDPOINT,
  desktopCallbackUrl,
  isDesktopAuthValue,
  pkceChallenge,
  randomDesktopValue,
  timingSafeEqualStrings,
} from './desktop-link.ts';

/** One-time codes expire after this many seconds (the hand-off from browser to app is immediate). */
export const DESKTOP_CODE_TTL_SECONDS = 120;

/** Codes are stored as `desktop-code:<SHA-256 base64url>` in `verification`, never in plain text. */
export async function desktopCodeIdentifier(code: string): Promise<string> {
  return `desktop-code:${await pkceChallenge(code)}`;
}

const storedCodeSchema = z.object({ userId: z.string().min(1), challenge: z.string() });

function invalidGrant(): APIError {
  return new APIError('BAD_REQUEST', {
    code: 'invalid_grant',
    message: 'This sign-in code is invalid or has expired. Start signing in again from the app.',
  });
}

export interface DesktopAuthOptions {
  db: Db;
  /** For tests. */
  now?: () => Date;
}

export function desktopAuth({ db, now = () => new Date() }: DesktopAuthOptions) {
  return {
    id: 'oat-desktop',
    endpoints: {
      createDesktopCode: createAuthEndpoint(
        DESKTOP_CODE_ENDPOINT,
        {
          method: 'POST',
          body: z.object({ state: z.string(), challenge: z.string() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          // A signed-in *browser* (cookie session) only, not a bearer token (e.g. the desktop's own).
          if (ctx.request?.headers.get('authorization')) {
            throw new APIError('FORBIDDEN', { message: 'Sign in with your browser.' });
          }
          const { state, challenge } = ctx.body;
          if (!isDesktopAuthValue(state) || !isDesktopAuthValue(challenge)) {
            throw new APIError('BAD_REQUEST', {
              code: 'invalid_request',
              message: 'This sign-in link is incomplete. Start signing in again from the app.',
            });
          }
          const code = randomDesktopValue();
          await db.insert(verification).values({
            id: newId(),
            identifier: await desktopCodeIdentifier(code),
            value: JSON.stringify({ userId: ctx.context.session.user.id, challenge }),
            expiresAt: new Date(now().getTime() + DESKTOP_CODE_TTL_SECONDS * 1000),
          });
          ctx.setHeader('cache-control', 'no-store');
          return ctx.json({ redirectUrl: desktopCallbackUrl(code, state) });
        },
      ),
      exchangeDesktopCode: createAuthEndpoint(
        DESKTOP_TOKEN_ENDPOINT,
        {
          method: 'POST',
          body: z.object({ code: z.string(), verifier: z.string() }),
        },
        async (ctx) => {
          const { code, verifier } = ctx.body;
          if (!isDesktopAuthValue(code) || !isDesktopAuthValue(verifier)) throw invalidGrant();
          // Single use: whoever deletes the row owns the code, even with concurrent requests.
          const [row] = await db
            .delete(verification)
            .where(
              and(
                eq(verification.identifier, await desktopCodeIdentifier(code)),
                gt(verification.expiresAt, now()),
              ),
            )
            .returning({ value: verification.value });
          if (!row) throw invalidGrant();
          let stored: z.infer<typeof storedCodeSchema>;
          try {
            stored = storedCodeSchema.parse(JSON.parse(row.value));
          } catch {
            throw invalidGrant();
          }
          if (!timingSafeEqualStrings(await pkceChallenge(verifier), stored.challenge)) {
            throw invalidGrant();
          }
          const user = await ctx.context.internalAdapter.findUserById(stored.userId);
          if (!user) throw invalidGrant();
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create a session.' });
          }
          // Sets the (signed) session cookie; the bearer plugin copies it into `set-auth-token`.
          await setSessionCookie(ctx, { session, user });
          ctx.setHeader('cache-control', 'no-store');
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name || null } });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
