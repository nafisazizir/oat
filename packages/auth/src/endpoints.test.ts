/**
 * Inventory of the Better Auth HTTP endpoints behind `apps/web` `/api/auth/[...all]` (5.5 authz audit).
 * Fails when a Better Auth upgrade or a new plugin adds, renames or drops a route, so every endpoint the
 * catch-all serves has been looked at: either it is not served (`disabled` via `DISABLED_AUTH_PATHS`,
 * `blocked` by our before-hook, `route` by the web route) or it is `served` with the reason it is safe.
 * Deny cases for the served ones live in `*.int.test.ts` (members, desktop, google-calendar, auth).
 */
import { describe, expect, it } from 'vitest';

import { DEV_AUTH_SECRET } from './config.ts';
import { isBlockedAuthPath } from './magic-link.ts';
import { createMemoryRateLimiter } from './rate-limit.ts';
import { BLOCKED_ORGANIZATION_PATHS, createAuth, DISABLED_AUTH_PATHS } from './server.ts';

type Policy =
  { status: 'served'; why: string } | { status: 'disabled' | 'blocked' | 'route'; why?: string };

const SELF = 'Session required; acts only on the caller’s own user/sessions/accounts.';

/** Keyed `<METHOD> <path>` as Better Auth registers them (base path `/api/auth` omitted). */
const ENDPOINTS: Record<string, Policy> = {
  // Sign-in and sessions
  'POST /sign-in/magic-link': {
    status: 'served',
    why: 'Public by design; per-IP + per-email rate limits; mails a link to the address only.',
  },
  'GET /magic-link/verify': {
    status: 'route',
    why: 'Login CSRF: the web route 404s it; only the same-origin POST /api/sign-in/magic-link calls it in-process.',
  },
  'POST /sign-in/social': {
    status: 'served',
    why: 'Public by design (Google OIDC + PKCE); the calendar provider is refused (link-only).',
  },
  'GET /callback/:id': {
    status: 'served',
    why: 'OAuth callback; state + PKCE checked by Better Auth.',
  },
  'POST /callback/:id': { status: 'served', why: 'OAuth callback (form_post); as above.' },
  'GET /get-session': {
    status: 'served',
    why: 'The caller’s own session (cookie or signed bearer).',
  },
  'POST /get-session': { status: 'served', why: 'As GET.' },
  'POST /sign-out': { status: 'served', why: SELF },
  'GET /list-sessions': { status: 'served', why: SELF },
  'POST /revoke-session': { status: 'served', why: `${SELF} Token must belong to the caller.` },
  'POST /revoke-sessions': { status: 'served', why: SELF },
  'POST /revoke-other-sessions': { status: 'served', why: SELF },
  'POST /update-session': { status: 'disabled', why: 'No client-settable session fields.' },
  'POST /desktop/code': {
    status: 'served',
    why: 'Cookie session only (bearer refused); one-time hashed code, 2 min (1.8).',
  },
  'POST /desktop/token': {
    status: 'served',
    why: 'Public by design: redeems a one-time code with its PKCE verifier (1.8).',
  },
  // Accounts and profile
  'POST /update-user': {
    status: 'served',
    why: `${SELF} Our before-hook allows only \`name\` (1–100 chars); avatar/email refused.`,
  },
  'GET /list-accounts': { status: 'served', why: `${SELF} No tokens in the answer.` },
  'POST /link-social': {
    status: 'served',
    why: `${SELF} Email must match; calendar grant only via the consent redirect (no id_token).`,
  },
  'POST /unlink-account': {
    status: 'served',
    why: `${SELF} Better Auth refuses unlinking the last account.`,
  },
  'GET /account-info': { status: 'disabled', why: 'Would expose provider data to the browser.' },
  'POST /get-access-token': { status: 'disabled', why: 'Provider tokens stay on the server.' },
  'POST /refresh-token': { status: 'disabled', why: 'Provider tokens stay on the server.' },
  'POST /change-email': { status: 'disabled' },
  'POST /delete-user': { status: 'disabled' },
  'GET /delete-user/callback': { status: 'disabled' },
  'POST /send-verification-email': { status: 'disabled' },
  'GET /verify-email': { status: 'disabled' },
  // Passwords (Oat has none)
  'POST /sign-in/email': { status: 'disabled' },
  'POST /sign-up/email': { status: 'disabled' },
  'POST /change-password': { status: 'disabled' },
  'POST /request-password-reset': { status: 'disabled' },
  'POST /reset-password': { status: 'disabled' },
  'POST /verify-password': { status: 'disabled' },
  'GET /reset-password/:token': {
    status: 'served',
    why: 'Inert: only redirects with a reset token, and no password reset can be requested.',
  },
  // Workspaces (organization plugin): Better Auth role checks (access.ts) + our hooks
  'POST /organization/create': {
    status: 'served',
    why: 'Always a team workspace created by the caller; per-user cap; personal- slugs reserved.',
  },
  'POST /organization/update': {
    status: 'served',
    why: 'organization:update = owner/admin; hook: name/slug/logo only, slug owner-only, live workspace.',
  },
  'POST /organization/delete': { status: 'blocked', why: 'Our soft delete (D-22).' },
  'POST /organization/check-slug': { status: 'disabled', why: 'Workspace-address probing.' },
  'POST /organization/set-active': {
    status: 'served',
    why: 'Better Auth requires membership; hook refuses soft-deleted workspaces.',
  },
  'GET /organization/list': {
    status: 'served',
    why: 'The caller’s own workspaces; after-hook hides soft-deleted ones.',
  },
  'GET /organization/get-organization': {
    status: 'served',
    why: 'Members only (Better Auth); hook 404s soft-deleted workspaces.',
  },
  'GET /organization/get-full-organization': {
    status: 'served',
    why: 'Members only (Better Auth); hook 404s soft-deleted workspaces.',
  },
  'GET /organization/list-members': {
    status: 'served',
    why: 'Members only (Better Auth); hook 404s soft-deleted workspaces.',
  },
  'GET /organization/get-active-member': {
    status: 'served',
    why: 'The caller’s own membership; hook 404s soft-deleted workspaces.',
  },
  'GET /organization/get-active-member-role': {
    status: 'served',
    why: 'The caller’s own role; hook 404s soft-deleted workspaces.',
  },
  'POST /organization/has-permission': {
    status: 'served',
    why: 'Answers about the caller’s own role in a workspace they belong to.',
  },
  'POST /organization/update-member-role': {
    status: 'blocked',
    why: 'members.ts under a row lock.',
  },
  'POST /organization/remove-member': { status: 'blocked', why: 'members.ts under a row lock.' },
  'POST /organization/leave': { status: 'blocked', why: 'members.ts under a row lock.' },
  'POST /organization/invite-member': {
    status: 'served',
    why: 'Hook: @oat/core canInvite on fresh rows (resend too) + per-recipient/inviter limits.',
  },
  'POST /organization/cancel-invitation': {
    status: 'served',
    why: 'invitation:cancel = owner/admin of the invite’s workspace (Better Auth).',
  },
  'GET /organization/list-invitations': {
    status: 'served',
    why: 'Hook: canManageMembers (owners/admins); soft-deleted 404.',
  },
  'GET /organization/get-invitation': {
    status: 'served',
    why: 'Recipient only (Better Auth compares the session email).',
  },
  'GET /organization/list-user-invitations': {
    status: 'served',
    why: 'Invitations addressed to the caller’s own email.',
  },
  'POST /organization/accept-invitation': {
    status: 'served',
    why: 'Recipient + verified email; hook: live team workspace, inviter still allowed.',
  },
  'POST /organization/reject-invitation': {
    status: 'served',
    why: 'Recipient only (Better Auth compares the session email).',
  },
  // Inert
  'GET /ok': { status: 'served', why: 'Liveness, no data.' },
  'GET /error': { status: 'served', why: 'Static error page.' },
};

function servedEndpoints(): string[] {
  const auth = createAuth({
    db: {} as never, // never queried: we only read the endpoint table
    config: {
      secret: DEV_AUTH_SECRET,
      baseURL: 'http://localhost:3000',
      trustedOrigins: [],
      smtp: { host: 'localhost', port: 1025, from: 'Oat <a@b.test>' },
      google: { issuer: 'http://localhost:9', clientId: 'x', clientSecret: 'x' },
      maxTeamWorkspaces: 1,
      production: false,
    },
    mailer: { send: async () => {} },
    rateLimiter: createMemoryRateLimiter(),
  });
  const keys: string[] = [];
  type Endpoint = { path?: string; options?: { method?: string | string[] } };
  for (const endpoint of Object.values(auth.api as unknown as Record<string, Endpoint>)) {
    if (!endpoint.path) continue; // server-only (e.g. addMember, setPassword): no HTTP route
    const methods = [endpoint.options?.method ?? 'GET'].flat();
    for (const method of methods) keys.push(`${method} ${endpoint.path}`);
  }
  return keys.sort();
}

describe('Better Auth endpoint inventory', () => {
  const served = servedEndpoints();

  it('every HTTP endpoint is classified (update ENDPOINTS after a Better Auth upgrade)', () => {
    expect(served).toEqual(Object.keys(ENDPOINTS).sort());
  });

  it('classifications match the config', () => {
    const pathOf = (key: string) => key.split(' ')[1]!;
    for (const [key, policy] of Object.entries(ENDPOINTS)) {
      const path = pathOf(key);
      expect(DISABLED_AUTH_PATHS.includes(path), key).toBe(policy.status === 'disabled');
      expect(BLOCKED_ORGANIZATION_PATHS.has(path), key).toBe(policy.status === 'blocked');
      expect(isBlockedAuthPath(`/api/auth${path}`), key).toBe(policy.status === 'route');
      if (policy.status === 'served') expect(policy.why.length, key).toBeGreaterThan(0);
    }
  });

  it('nothing disabled or blocked is stale', () => {
    const paths = new Set(served.map((k) => k.split(' ')[1]));
    expect(DISABLED_AUTH_PATHS.filter((p) => !paths.has(p))).toEqual([]);
    expect([...BLOCKED_ORGANIZATION_PATHS].filter((p) => !paths.has(p))).toEqual([]);
  });
});
