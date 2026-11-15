/**
 * Better Auth server (D-9): magic link (SMTP → Mailpit in dev), Google through OIDC discovery (the mock
 * issuer in dev, accounts.google.com in prod; same code path), the link-only Google Calendar grant (7.4,
 * `google-calendar.ts`), the organization plugin mapped onto
 * workspaces (`@oat/db` auth-mapping) with our roles, and bearer tokens for the desktop app (1.8).
 *
 * Every user gets a personal workspace when they are created; every new session starts in it unless a
 * workspace is already active. Guards on the organization plugin keep personal workspaces single-member
 * and invitations within `@oat/core` rules.
 */
import { canInvite, createPermissionContext, type Role, ROLES } from '@oat/core';
import { type Db, membership, newId, organizationOptions, schema, workspace } from '@oat/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { bearer, genericOAuth, magicLink, organization } from 'better-auth/plugins';
import { and, count, eq } from 'drizzle-orm';

import { ac, roles } from './access.ts';
import { type AuthConfig, isLoopbackUrl } from './config.ts';
import { desktopAuth } from './desktop.ts';
import { createSmtpMailer, type Mailer, magicLinkEmail } from './email.ts';
import { GOOGLE_CALENDAR_PROVIDER_ID, GOOGLE_CALENDAR_SCOPES } from './google-calendar.ts';
import { magicLinkConfirmUrl } from './magic-link.ts';
import { GOOGLE_PROVIDER_ID } from './providers.ts';
import { createRateLimiter, type RateLimiter } from './rate-limit.ts';
import {
  ensurePersonalWorkspace,
  findPersonalWorkspaceId,
  PERSONAL_SLUG_PREFIX,
} from './workspaces.ts';

/** Magic links are single-use and expire after this many seconds. */
export const MAGIC_LINK_EXPIRES_IN = 15 * 60;

/**
 * Per-email cap on magic-link sends (on top of Better Auth's per-IP limit), so nobody can mail-bomb an
 * address from rotating IPs: this many links per window.
 */
export const MAGIC_LINK_EMAIL_LIMIT = { max: 5, windowSec: 15 * 60 } as const;

/** Workspace fields an owner/admin may change through `organization/update`. */
const UPDATABLE_WORKSPACE_FIELDS = new Set(['name', 'slug', 'logo', 'metadata']);

export interface CreateAuthOptions {
  db: Db;
  config: AuthConfig;
  /** Defaults to SMTP from `config.smtp`. Tests may pass a capturing mailer. */
  mailer?: Mailer;
  /** Defaults to Redis at `config.redisUrl`, else in-memory. */
  rateLimiter?: RateLimiter;
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

function forbidden(message: string): APIError {
  return new APIError('FORBIDDEN', { message });
}

export function createAuth({
  db,
  config,
  mailer = createSmtpMailer(config.smtp),
  rateLimiter = createRateLimiter(config.redisUrl),
}: CreateAuthOptions) {
  // The dev mock issuer (loopback) gets the scope bookkeeping below; a real issuer never does.
  const mockIssuer = isLoopbackUrl(config.google.issuer);
  return betterAuth({
    appName: 'Oat',
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.baseURL, ...config.trustedOrigins],
    telemetry: { enabled: false },
    // `transaction: true`: multi-row writes (OAuth user + account, workspace + owner membership) are
    // atomic. `user.create.after` hooks run after commit, so our own connection sees the user row.
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      database: { generateId: () => newId() },
      // `__Secure-` cookies whenever the app is served over https; http only on localhost dev.
      useSecureCookies: config.baseURL.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    account: {
      // Link Google to an existing (magic-link) user with the same email: both sides must have a
      // verified email (Better Auth's default rule), which magic-link users and Google always do.
      accountLinking: { enabled: true },
      // OAuth access/refresh tokens are stored encrypted (Better Auth's symmetricEncrypt: XChaCha20-Poly1305,
      // key derived from the auth secret; rotate with BETTER_AUTH_SECRETS, see DEV.md). Rows written before
      // this was on still read as plain text.
      encryptOAuthTokens: true,
    },
    // Provider tokens stay on the server: the app reads them through `auth.api` (not affected by this list),
    // so the HTTP routes that would hand a signed-in browser its plaintext Google tokens are switched off.
    disabledPaths: ['/get-access-token', '/refresh-token', '/account-info'],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body = ctx.body as { provider?: unknown; idToken?: unknown } | undefined;
        // The calendar grant is link-only, through the OAuth redirect (`/link-social` from a signed-in
        // session): it must never sign anyone in, create a user, or be linked from a caller-supplied
        // id_token + tokens (that path skips the code exchange, so nothing proves what was granted).
        if (body?.provider === GOOGLE_CALENDAR_PROVIDER_ID) {
          if (ctx.path === '/sign-in/social') {
            throw new APIError('BAD_REQUEST', {
              message: 'Google Calendar can only be connected from settings.',
            });
          }
          if (ctx.path === '/link-social' && body.idToken !== undefined) {
            throw new APIError('BAD_REQUEST', {
              message: 'Google Calendar must be connected through Google’s consent screen.',
            });
          }
        }
        if (ctx.path !== '/sign-in/magic-link') return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== 'string') return; // the endpoint's own validation rejects it
        const { max, windowSec } = MAGIC_LINK_EMAIL_LIMIT;
        const hit = await rateLimiter.hit(
          `magic-link:${email.trim().toLowerCase()}`,
          max,
          windowSec,
        );
        if (!hit.allowed) {
          throw new APIError(
            'TOO_MANY_REQUESTS',
            { message: 'Too many sign-in links for this address. Try again later.' },
            { 'retry-after': String(hit.retryAfter) },
          );
        }
      }),
    },
    databaseHooks: {
      account: {
        create: {
          // RFC 6749 §5.1: a token response without `scope` granted exactly what was asked for. Google
          // always says; the dev mock issuer doesn't, so record the requested calendar scopes then — only
          // with a local (mock) issuer, never a real one, and only for code-exchange links (the id_token
          // link path is refused above).
          before: async (account) => {
            if (
              !mockIssuer ||
              account.providerId !== GOOGLE_CALENDAR_PROVIDER_ID ||
              account.scope
            ) {
              return;
            }
            return { data: { ...account, scope: GOOGLE_CALENDAR_SCOPES.join(',') } };
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalWorkspace(db, user.id);
          },
        },
      },
      session: {
        create: {
          // Every sign-in starts in the personal workspace (unless something already chose one).
          // Also heals users created before this hook existed or whose after-hook failed.
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const personal =
              (await findPersonalWorkspaceId(db, session.userId)) ??
              (await ensurePersonalWorkspace(db, session.userId));
            return { data: { ...session, activeOrganizationId: personal } };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN,
        storeToken: 'hashed',
        // The email links to a confirm page that POSTs, so link scanners can't consume it.
        sendMagicLink: async ({ email, url }) => {
          await mailer.send(
            magicLinkEmail({
              to: email,
              url: magicLinkConfirmUrl(config.baseURL, url),
              expiresInMinutes: MAGIC_LINK_EXPIRES_IN / 60,
            }),
          );
        },
      }),
      genericOAuth({
        config: [
          {
            providerId: GOOGLE_PROVIDER_ID,
            name: 'Google',
            discoveryUrl: `${config.google.issuer}/.well-known/openid-configuration`,
            requireIdTokenVerification: true,
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
          {
            // Same issuer and OAuth client; its own callback (`/api/auth/callback/google-calendar`, a
            // second redirect URI to register with Google) and account row. Offline + consent so Google
            // returns a refresh token every time.
            providerId: GOOGLE_CALENDAR_PROVIDER_ID,
            name: 'Google Calendar',
            discoveryUrl: `${config.google.issuer}/.well-known/openid-configuration`,
            requireIdTokenVerification: true,
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            scopes: GOOGLE_CALENDAR_SCOPES,
            accessType: 'offline',
            prompt: 'consent',
            pkce: true,
            disableSignUp: true,
          },
        ],
      }),
      organization({
        ...organizationOptions,
        ac,
        roles,
        creatorRole: 'owner',
        // Explicit: accepting an invite needs a verified email (magic link and Google both verify).
        requireEmailVerificationOnInvitation: true,
        // Cap on team workspaces a user creates (`AUTH_MAX_TEAM_WORKSPACES`). `true` = limit reached.
        organizationLimit: async (user) => {
          const [row] = await db
            .select({ n: count() })
            .from(workspace)
            .where(and(eq(workspace.createdBy, user.id), eq(workspace.kind, 'team')));
          return (row?.n ?? 0) >= config.maxTeamWorkspaces;
        },
        organizationHooks: {
          // Workspaces created through the API are always team workspaces (`kind` isn't accepted from
          // the body); personal ones are only made by `ensurePersonalWorkspace`.
          beforeCreateOrganization: async ({ organization: org, user }) => {
            if (typeof org.slug === 'string' && org.slug.startsWith(PERSONAL_SLUG_PREFIX)) {
              throw forbidden('That workspace address is reserved.');
            }
            return { data: { ...org, kind: 'team', createdBy: user.id } };
          },
          // Only name/slug/logo/metadata change; a personal workspace's slug never changes; team
          // workspaces can't take a reserved `personal-` slug.
          beforeUpdateOrganization: async ({ organization: changes, member }) => {
            for (const key of Object.keys(changes)) {
              if (!UPDATABLE_WORKSPACE_FIELDS.has(key)) {
                throw forbidden(`The workspace ${key} can’t be changed.`);
              }
            }
            const [current] = await db
              .select({ kind: workspace.kind, slug: workspace.slug })
              .from(workspace)
              .where(eq(workspace.id, member.organizationId));
            if (!current) throw forbidden('Unknown workspace.');
            if (typeof changes.slug === 'string' && changes.slug !== current.slug) {
              if (current.kind === 'personal') {
                throw forbidden('A personal workspace’s address can’t be changed.');
              }
              if (changes.slug.startsWith(PERSONAL_SLUG_PREFIX)) {
                throw forbidden('That workspace address is reserved.');
              }
            }
          },
          beforeCreateInvitation: async ({ invitation, inviter, organization: org }) => {
            if (!isRole(invitation.role)) throw forbidden('Unknown role.');
            const rows = await db
              .select({
                workspaceId: membership.workspaceId,
                userId: membership.userId,
                role: membership.role,
              })
              .from(membership)
              .where(and(eq(membership.workspaceId, org.id), eq(membership.userId, inviter.id)));
            const ctx = createPermissionContext({ userId: inviter.id, memberships: rows });
            if (!canInvite(ctx, { id: org.id, kind: org.kind }, invitation.role)) {
              throw forbidden('You can’t invite people with that role to this workspace.');
            }
          },
          beforeAddMember: async ({ organization: org }) => {
            if (org.kind === 'personal') throw forbidden('Personal workspaces have one member.');
          },
          beforeAcceptInvitation: async ({ organization: org }) => {
            if (org.kind === 'personal') throw forbidden('Personal workspaces have one member.');
          },
          beforeUpdateMemberRole: async ({ organization: org, newRole }) => {
            if (org.kind === 'personal') throw forbidden('Personal workspaces have one member.');
            if (!isRole(newRole)) throw forbidden('Unknown role.');
          },
          beforeRemoveMember: async ({ organization: org }) => {
            if (org.kind === 'personal') throw forbidden('Personal workspaces have one member.');
          },
        },
      }),
      // Desktop sign-in hand-off (1.8): one-time code from the browser → PKCE exchange → new session.
      desktopAuth({ db }),
      // Desktop (1.8) sends `Authorization: Bearer <token>`; only signed tokens are accepted.
      bearer({ requireSignature: true }),
      // Lets Server Actions set auth cookies. A no-op outside Next.js. Must stay last.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
