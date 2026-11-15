/**
 * "Connect Google Calendar" (task 7.4): an incremental OAuth grant kept apart from sign-in.
 *
 * Sign-in (`google`) asks only for `openid email profile`. Calendar access is a second Better Auth provider,
 * `google-calendar` (same issuer and OAuth client), that is **link-only**: the signed-in user starts it with
 * `POST /api/auth/link-social { provider: 'google-calendar' }`, Google asks for `calendar.readonly` (offline,
 * so there is a refresh token), and the tokens land on their own `account` row (`providerId:
 * google-calendar`). Keeping a separate row means a later Google sign-in, which overwrites the `google`
 * row's tokens with sign-in-scoped ones, can never take calendar access away. Using it to sign in is refused
 * (`server.ts` hook), so it never becomes a login method. Better Auth's linking rules apply: the Google
 * account's email must be verified and match the user's.
 *
 * Tokens are encrypted at rest (`account.encryptOAuthTokens`) and refreshed by Better Auth
 * (`getAccessToken` refreshes when the access token is about to expire; `refreshToken` forces it).
 */
import { type Db, schema } from '@oat/db';
import { and, desc, eq } from 'drizzle-orm';

import type { OidcProviderConfig } from './config.ts';
import { GOOGLE_CALENDAR_PROVIDER_ID } from './providers.ts';

export {
  GOOGLE_CALENDAR_PROVIDER_ID,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_SCOPES,
} from './providers.ts';

export interface GoogleCalendarConnection {
  /** Better Auth `account.id` (what `getAccessToken` / `refreshToken` take). */
  accountId: string;
  /** Google's account id (`sub`). */
  googleAccountId: string;
  /** From the id_token of the grant, for display. */
  email: string | null;
  scopes: string[];
  /** False if the user unticked calendar access on Google's consent screen. */
  hasCalendarScope: boolean;
  connectedAt: Date;
}

function idTokenEmail(idToken: string | null): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

export function parseScopes(scope: string | null | undefined): string[] {
  return (scope ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The user's Google Calendar grant, or null if they haven't connected one. */
export async function findGoogleCalendarConnection(
  db: Db,
  userId: string,
): Promise<GoogleCalendarConnection | null> {
  const [row] = await db
    .select({
      id: schema.account.id,
      accountId: schema.account.accountId,
      scope: schema.account.scope,
      idToken: schema.account.idToken,
      createdAt: schema.account.createdAt,
    })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, GOOGLE_CALENDAR_PROVIDER_ID),
      ),
    )
    .orderBy(desc(schema.account.updatedAt))
    .limit(1);
  if (!row) return null;
  const scopes = parseScopes(row.scope);
  return {
    accountId: row.id,
    googleAccountId: row.accountId,
    email: idTokenEmail(row.idToken),
    scopes,
    hasCalendarScope: scopes.some((s) => s.startsWith('https://www.googleapis.com/auth/calendar')),
    connectedAt: row.createdAt,
  };
}

/** The slice of the Better Auth API the token helpers use (keeps this module testable without one). */
export interface AccountTokenApi {
  getAccessToken(input: {
    body: { accountId: string; userId: string };
  }): Promise<{ accessToken?: string | null }>;
  refreshToken(input: {
    body: { accountId: string; userId: string };
  }): Promise<{ accessToken?: string | null }>;
}

/**
 * A token provider for `@oat/calendar/google`: the stored access token (Better Auth refreshes it when it is
 * about to expire), or a forced refresh after Google refused it. Server-side only (no session needed).
 */
export function googleCalendarTokenProvider(
  api: AccountTokenApi,
  connection: { accountId: string; userId: string },
): (options: { forceRefresh: boolean }) => Promise<string> {
  const body = { accountId: connection.accountId, userId: connection.userId };
  return async ({ forceRefresh }) => {
    const tokens = forceRefresh
      ? await api.refreshToken({ body })
      : await api.getAccessToken({ body });
    if (!tokens.accessToken) throw new Error('Google Calendar account has no access token');
    return tokens.accessToken;
  };
}

/**
 * Best-effort RFC 7009 revocation at the issuer's `revocation_endpoint` (Google revokes the whole grant,
 * refresh token included). Never throws; false if it couldn't be done.
 */
export async function revokeOAuthToken(
  provider: OidcProviderConfig,
  token: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 3000);
  try {
    const discovery = await doFetch(`${provider.issuer}/.well-known/openid-configuration`, {
      signal,
    });
    if (!discovery.ok) return false;
    const { revocation_endpoint: endpoint } = (await discovery.json()) as {
      revocation_endpoint?: unknown;
    };
    if (typeof endpoint !== 'string') return false;
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
      }),
      signal,
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Disconnects Google Calendar: revokes the grant at the issuer (best effort) and deletes the
 * `google-calendar` account row. Sign-in accounts are untouched. Idempotent.
 *
 * Note: Google revokes the whole grant of our OAuth client, so the sign-in consent goes too; the next
 * "Continue with Google" just shows the consent screen again (sign-in never relies on stored tokens).
 */
export async function disconnectGoogleCalendar(options: {
  db: Db;
  api: AccountTokenApi;
  google: OidcProviderConfig;
  userId: string;
  fetch?: typeof fetch;
}): Promise<{ disconnected: boolean; revoked: boolean }> {
  const { db, api, google, userId } = options;
  const connection = await findGoogleCalendarConnection(db, userId);
  if (!connection) return { disconnected: false, revoked: false };
  let revoked = false;
  try {
    const token = await googleCalendarTokenProvider(api, {
      accountId: connection.accountId,
      userId,
    })({ forceRefresh: false });
    revoked = await revokeOAuthToken(google, token, { fetch: options.fetch });
  } catch {
    // No usable token (already revoked/expired): nothing to revoke.
  }
  await db
    .delete(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, GOOGLE_CALENDAR_PROVIDER_ID),
      ),
    );
  return { disconnected: true, revoked };
}
