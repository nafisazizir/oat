/**
 * Better Auth server (D-9): magic link (SMTP → Mailpit in dev), Google through OIDC discovery (the mock
 * issuer in dev, accounts.google.com in prod; same code path), the link-only Google Calendar grant (7.4,
 * `google-calendar.ts`), the organization plugin mapped onto
 * workspaces (`@oat/db` auth-mapping) with our roles, and bearer tokens for the desktop app (1.8).
 *
 * A new user who isn't invited anywhere gets a workspace of their own (D-36: one kind of workspace); every
 * new session starts in the workspace the user last switched to, else their oldest one, unless a workspace is
 * already active. Guards on the organization plugin keep invitations within `@oat/core` rules.
 */
import { canInvite, canManageMembers, createPermissionContext, type Role, ROLES } from '@oat/core';
import { type Db, membership, newId, organizationOptions, schema, workspace } from '@oat/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { bearer, genericOAuth, magicLink, organization } from 'better-auth/plugins';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';

import { ac, roles } from './access.ts';
import { type AuthConfig, isLoopbackUrl } from './config.ts';
import { desktopAuth } from './desktop.ts';
import { createSmtpMailer, invitationEmail, type Mailer, magicLinkEmail } from './email.ts';
import { GOOGLE_CALENDAR_PROVIDER_ID, GOOGLE_CALENDAR_SCOPES } from './google-calendar.ts';
import { magicLinkConfirmUrl } from './magic-link.ts';
import {
  INVITE_EXPIRES_IN,
  inviterMayStillInvite,
  inviteTokenFor,
  isLiveWorkspace,
} from './members.ts';
import { GOOGLE_PROVIDER_ID } from './providers.ts';
import { createRateLimiter, type RateLimiter } from './rate-limit.ts';
import {
  ensureFirstWorkspace,
  rememberActiveWorkspace,
  startingWorkspaceId,
} from './workspaces.ts';

/** Magic links are single-use and expire after this many seconds. */
export const MAGIC_LINK_EXPIRES_IN = 15 * 60;

/**
 * Per-email cap on magic-link sends (on top of Better Auth's per-IP limit), so nobody can mail-bomb an
 * address from rotating IPs: this many links per window.
 */
export const MAGIC_LINK_EMAIL_LIMIT = { max: 5, windowSec: 15 * 60 } as const;

/**
 * Workspace fields an owner/admin may change through `organization/update` (the slug: owners only).
 * Lengths mirror the settings form.
 */
const UPDATABLE_WORKSPACE_FIELDS = new Set(['name', 'slug', 'logo']);
const MAX_WORKSPACE_NAME = 60;
const MAX_WORKSPACE_LOGO = 16;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Invitation emails (create and resend), on top of Better Auth's per-IP limit: per recipient and per
 * inviter, so nobody can mail-bomb an address or relay text from Oat's domain. Fails open like the
 * magic-link limit when Redis is down.
 */
export const INVITE_EMAIL_LIMITS = {
  perRecipient: { max: 3, windowSec: 60 * 60 },
  perInviter: { max: 30, windowSec: 60 * 60 },
} as const;

/**
 * Better Auth read endpoints scoped to one workspace (`organizationId` in the query/body, else the
 * session's active one): a soft-deleted workspace is not served.
 */
const WORKSPACE_READ_PATHS: ReadonlySet<string> = new Set([
  '/organization/get-organization',
  '/organization/get-full-organization',
  '/organization/list-members',
  '/organization/list-invitations',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
]);

/**
 * Better Auth member endpoints we don't serve: role changes, removals and leaving go through
 * `members.ts`, which checks `@oat/core` and the last-owner rule under a row lock in one transaction
 * (Better Auth's versions can't). Workspace deletion is our own soft delete (D-22).
 */
export const BLOCKED_ORGANIZATION_PATHS: ReadonlySet<string> = new Set([
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
  '/organization/delete',
]);

/**
 * Better Auth HTTP routes we never serve (`disabledPaths`: 404 before any handler runs; `auth.api` calls
 * in-process are unaffected). The full inventory of what is served, and why, is pinned in
 * `endpoints.test.ts` (5.5).
 * - Provider tokens stay on the server: these would hand a signed-in browser its plaintext Google tokens.
 * - No passwords in Oat (magic link + Google): the email/password family, off today by config, stays off
 *   even if `emailAndPassword` is ever switched on for something else.
 * - Account lifecycle we don't offer (yet): changing the email (it is the invite/identity key), deleting
 *   the user (would cascade through workspaces Oat soft-deletes instead, D-22), email verification
 *   (magic link and Google verify), session fields (none are client-settable).
 * - Slug lookups would let anyone probe which workspace addresses exist; the app never needs them.
 */
export const DISABLED_AUTH_PATHS: readonly string[] = [
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  '/sign-in/email',
  '/sign-up/email',
  '/change-password',
  '/request-password-reset',
  '/reset-password',
  '/verify-password',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/send-verification-email',
  '/verify-email',
  '/update-session',
  '/organization/check-slug',
];

/** Better Auth endpoints after which the session's active workspace is a new one (see the after-hook). */
const ACTIVATING_PATHS: ReadonlySet<string> = new Set([
  '/organization/set-active',
  '/organization/create',
  '/organization/accept-invitation',
]);

/** Longest display name `/update-user` accepts (its only changeable field). */
const MAX_USER_NAME = 100;

/** The `/invite/<token>` page an invitation email links to. */
export function inviteUrl(baseURL: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, baseURL).toString();
}

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
    // Not served over HTTP (see DISABLED_AUTH_PATHS); the app's own `auth.api` calls are unaffected.
    disabledPaths: [...DISABLED_AUTH_PATHS],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (BLOCKED_ORGANIZATION_PATHS.has(ctx.path)) {
          throw new APIError('NOT_FOUND', { message: 'Not found.' });
        }
        if (ctx.path === '/update-user') {
          // Only the display name. The avatar URL is rendered in teammates' browsers, so it only ever comes
          // from the identity provider (an arbitrary URL would be a tracking pixel on every members list).
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const extra = Object.keys(body).filter((key) => key !== 'name');
          if (extra.length > 0) {
            throw forbidden(`The ${extra[0]} can’t be changed here.`);
          }
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name.length === 0 || name.length > MAX_USER_NAME) {
            throw new APIError('BAD_REQUEST', {
              message: `Names are 1–${MAX_USER_NAME} characters.`,
            });
          }
          return;
        }
        if (ctx.path === '/organization/invite-member') {
          const session = await getSessionFromCtx(ctx);
          const email = (ctx.body as { email?: unknown } | undefined)?.email;
          if (!session || typeof email !== 'string') return; // the endpoint rejects these itself
          // Policy before anything is written or mailed — including Better Auth's `resend` branch, which
          // skips `beforeCreateInvitation`: live workspace + `@oat/core` canInvite on current rows.
          const body = ctx.body as { organizationId?: unknown; role?: unknown };
          const workspaceId =
            typeof body.organizationId === 'string'
              ? body.organizationId
              : session.session.activeOrganizationId;
          if (
            !workspaceId ||
            typeof body.role !== 'string' ||
            !(await inviterMayStillInvite(db, {
              inviterId: session.user.id,
              workspaceId,
              role: body.role,
            }))
          ) {
            throw forbidden('You can’t invite people with that role to this workspace.');
          }
          const { perRecipient, perInviter } = INVITE_EMAIL_LIMITS;
          const [to, from] = await Promise.all([
            rateLimiter.hit(
              `invite:to:${email.trim().toLowerCase()}`,
              perRecipient.max,
              perRecipient.windowSec,
            ),
            rateLimiter.hit(`invite:from:${session.user.id}`, perInviter.max, perInviter.windowSec),
          ]);
          const blocked = [to, from].find((hit) => !hit.allowed);
          if (blocked) {
            throw new APIError(
              'TOO_MANY_REQUESTS',
              { message: 'Too many invitations. Try again later.' },
              { 'retry-after': String(blocked.retryAfter) },
            );
          }
          return;
        }
        if (WORKSPACE_READ_PATHS.has(ctx.path)) {
          const session = await getSessionFromCtx(ctx);
          if (!session) return; // the endpoint answers 401 itself
          const input = { ...(ctx.query ?? {}), ...((ctx.body as object | undefined) ?? {}) } as {
            organizationId?: unknown;
            organizationSlug?: unknown;
          };
          const id =
            typeof input.organizationId === 'string'
              ? input.organizationId
              : typeof input.organizationSlug === 'string'
                ? undefined
                : (session.session.activeOrganizationId ?? undefined);
          const slug =
            typeof input.organizationSlug === 'string' ? input.organizationSlug : undefined;
          if (id === undefined && slug === undefined) return;
          const [row] = await db
            .select({ id: workspace.id, deletedAt: workspace.deletedAt })
            .from(workspace)
            .where(id !== undefined ? eq(workspace.id, id) : eq(workspace.slug, slug!));
          if (row && row.deletedAt !== null) {
            throw new APIError('NOT_FOUND', { message: 'Workspace not found.' });
          }
          // Pending invitations (invitee addresses) are for the people who manage members.
          if (row && ctx.path === '/organization/list-invitations') {
            const ctxRows = await db
              .select({
                workspaceId: membership.workspaceId,
                userId: membership.userId,
                role: membership.role,
              })
              .from(membership)
              .where(
                and(eq(membership.workspaceId, row.id), eq(membership.userId, session.user.id)),
              );
            const permissions = createPermissionContext({
              userId: session.user.id,
              memberships: ctxRows,
            });
            if (!canManageMembers(permissions, { id: row.id })) {
              throw new APIError('FORBIDDEN', {
                message: 'Only owners and admins see invitations.',
              });
            }
          }
          return;
        }
        if (ctx.path === '/organization/set-active') {
          // A soft-deleted workspace can't become active again (it's hidden everywhere).
          const body = ctx.body as
            { organizationId?: unknown; organizationSlug?: unknown } | undefined;
          const id = typeof body?.organizationId === 'string' ? body.organizationId : undefined;
          const slug =
            typeof body?.organizationSlug === 'string' ? body.organizationSlug : undefined;
          if (id !== undefined || slug !== undefined) {
            const [row] = await db
              .select({ deletedAt: workspace.deletedAt })
              .from(workspace)
              .where(id !== undefined ? eq(workspace.id, id) : eq(workspace.slug, slug!));
            if (row && row.deletedAt !== null) {
              throw new APIError('BAD_REQUEST', { message: 'Workspace not found.' });
            }
          }
          return;
        }
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
      // `organization/list` never shows soft-deleted workspaces (our own lists skip them too).
      after: createAuthMiddleware(async (ctx) => {
        if (ACTIVATING_PATHS.has(ctx.path)) {
          // Remember the workspace this session just moved to for the user's next sign-in, on any device
          // (D-36): a switch, a workspace they created, an invitation they accepted (Better Auth makes
          // the last two active in the session itself). Only when the call succeeded: Better Auth checked
          // membership, the before-hooks that the workspace is live.
          const returned = ctx.context.returned as
            | {
                id?: unknown;
                member?: { organizationId?: unknown } | null;
                invitation?: { organizationId?: unknown } | null;
              }
            | null
            | undefined;
          const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
          if (!session || returned instanceof Error) return;
          const body = ctx.body as { keepCurrentActiveOrganization?: unknown } | undefined;
          let id: unknown;
          if (ctx.path === '/organization/accept-invitation') {
            id = returned?.member?.organizationId ?? returned?.invitation?.organizationId;
            if (typeof id !== 'string') return;
          } else if (ctx.path === '/organization/create') {
            // A workspace created without switching to it is not where the user is.
            if (body?.keepCurrentActiveOrganization === true || typeof returned?.id !== 'string') {
              return;
            }
            id = returned.id;
          } else {
            id = returned?.id; // set-active: `null` clears it
          }
          await rememberActiveWorkspace(db, session.user.id, typeof id === 'string' ? id : null);
          return;
        }
        if (ctx.path !== '/organization/list') return;
        const returned = ctx.context.returned;
        if (!Array.isArray(returned) || returned.length === 0) return;
        const ids = returned.map((o: { id: string }) => o.id);
        const deleted = new Set(
          (
            await db
              .select({ id: workspace.id })
              .from(workspace)
              .where(and(inArray(workspace.id, ids), isNotNull(workspace.deletedAt)))
          ).map((r) => r.id),
        );
        if (deleted.size === 0) return;
        return ctx.json(returned.filter((o: { id: string }) => !deleted.has(o.id)));
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
          // No invitation waiting → a workspace of their own (an invited user joins that one instead).
          after: async (user) => {
            await ensureFirstWorkspace(db, user.id);
          },
        },
      },
      session: {
        create: {
          // Every sign-in starts in the workspace the user last switched to, else their oldest one
          // (unless something already chose one). Also heals users whose after-hook failed. A user who
          // only has a pending invitation starts without one (the invite page is where they go).
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const start =
              (await startingWorkspaceId(db, session.userId)) ??
              (await ensureFirstWorkspace(db, session.userId)).workspaceId;
            if (!start) return;
            return { data: { ...session, activeOrganizationId: start } };
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
        invitationExpiresIn: INVITE_EXPIRES_IN,
        // Our template, linking to `/invite/<token>` (the invite's own secret, not its id). Better Auth
        // calls this after the invite row is written (outside any transaction), so our connection sees it.
        // Backstop for the `invite-member` before-hook (Better Auth's resend path skips
        // `beforeCreateInvitation`). Better Auth logs, not returns, errors thrown here: nothing is sent.
        sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
          const allowed = await inviterMayStillInvite(db, {
            inviterId: inviter.user.id,
            workspaceId: org.id,
            role,
          });
          if (!allowed)
            throw forbidden('You can’t invite people with that role to this workspace.');
          const token = await inviteTokenFor(db, id);
          if (!token) throw new Error('invitation row missing after create');
          await mailer.send(
            invitationEmail({
              to: email,
              url: inviteUrl(config.baseURL, token),
              workspaceName: org.name,
              inviterName: inviter.user.name || inviter.user.email,
              role,
              expiresInDays: INVITE_EXPIRES_IN / 86_400,
            }),
          );
        },
        // Cap on workspaces a user creates themselves (`AUTH_MAX_TEAM_WORKSPACES`), on top of the one
        // made for them at sign-up. `true` = limit reached.
        organizationLimit: async (user) => {
          const [row] = await db
            .select({ n: count() })
            .from(workspace)
            .where(eq(workspace.createdBy, user.id));
          return (row?.n ?? 0) > config.maxTeamWorkspaces;
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org, user }) => {
            return { data: { ...org, createdBy: user.id } };
          },
          // Only name/slug/logo change.
          beforeUpdateOrganization: async ({ organization: changes, member }) => {
            for (const key of Object.keys(changes)) {
              if (!UPDATABLE_WORKSPACE_FIELDS.has(key)) {
                throw forbidden(`The workspace ${key} can’t be changed.`);
              }
            }
            const [current] = await db
              .select({ slug: workspace.slug, deletedAt: workspace.deletedAt })
              .from(workspace)
              .where(eq(workspace.id, member.organizationId));
            if (!current || current.deletedAt !== null) throw forbidden('Unknown workspace.');
            if ('name' in changes) {
              const name = typeof changes.name === 'string' ? changes.name.trim() : '';
              if (name.length === 0 || name.length > MAX_WORKSPACE_NAME) {
                throw new APIError('BAD_REQUEST', {
                  message: `Workspace names are 1–${MAX_WORKSPACE_NAME} characters.`,
                });
              }
            }
            if (
              'logo' in changes &&
              changes.logo != null &&
              (typeof changes.logo !== 'string' || changes.logo.length > MAX_WORKSPACE_LOGO)
            ) {
              throw new APIError('BAD_REQUEST', { message: 'The workspace icon is one emoji.' });
            }
            if (typeof changes.slug === 'string' && changes.slug !== current.slug) {
              if (member.role !== 'owner') {
                throw forbidden('Only owners can change the workspace address.');
              }
              if (!SLUG.test(changes.slug)) {
                throw new APIError('BAD_REQUEST', {
                  message: 'That workspace address isn’t valid.',
                });
              }
            }
          },
          beforeCreateInvitation: async ({ invitation, inviter, organization: org }) => {
            if (!isRole(invitation.role)) throw forbidden('Unknown role.');
            if (!(await isLiveWorkspace(db, org.id))) throw forbidden('Unknown workspace.');
            const rows = await db
              .select({
                workspaceId: membership.workspaceId,
                userId: membership.userId,
                role: membership.role,
              })
              .from(membership)
              .where(and(eq(membership.workspaceId, org.id), eq(membership.userId, inviter.id)));
            const ctx = createPermissionContext({ userId: inviter.id, memberships: rows });
            if (!canInvite(ctx, { id: org.id }, invitation.role)) {
              throw forbidden('You can’t invite people with that role to this workspace.');
            }
          },
          beforeAcceptInvitation: async ({ organization: org, invitation }) => {
            if (!(await isLiveWorkspace(db, org.id))) {
              throw forbidden('This workspace was deleted.');
            }
            // The invite only carries its sender's authority while they still have it (removed or
            // demoted since → refused).
            const stillAllowed = await inviterMayStillInvite(db, {
              inviterId: invitation.inviterId,
              workspaceId: org.id,
              role: invitation.role,
            });
            if (!stillAllowed) throw forbidden('This invitation is no longer valid.');
          },
          beforeUpdateMemberRole: async ({ newRole }) => {
            if (!isRole(newRole)) throw forbidden('Unknown role.');
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
