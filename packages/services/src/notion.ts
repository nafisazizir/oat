import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { decryptSecret, encryptSecret, type RateLimiter, type SecretSource } from '@oat/auth';
import { roleIn } from '@oat/core';
import { type Db, documentExport, integration, meeting, participant } from '@oat/db';
import {
  exchangeNotionCode,
  type FetchLike,
  NotionApiError,
  NotionAuthError,
  notionAuthorizeUrl,
  NotionTargetMissingError,
  NotionClient,
  type NotionConfig,
  type NotionDatabase,
  type NotionPage,
  notionTitle,
  pushNote,
  revokeNotionToken,
} from '@oat/integrations-notion';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type {
  NotionConnectionInfo,
  NotionDocumentStatus,
  NotionPushResult,
  NotionTargetOption,
} from './dto/api-types.ts';

import type { Actor } from './actor.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { getDocument } from './documents.ts';

/*
 * Notion integration (8.1), per user and Oat workspace: one `integration` row (provider `notion`) holds the
 * encrypted OAuth token (`secret_encrypted`, `@oat/auth` encryptSecret), the Notion workspace it belongs to
 * and the chosen target (`settings_json`). `document_export` remembers which Notion page each note went to,
 * so sending again updates that page.
 *
 * Authz: connecting needs membership of the workspace; sending needs read access to the note
 * (`getDocument` → `@oat/core` canReadDocument; unreadable = 404) and always uses the *sender's own*
 * connection for the note's workspace, never someone else's token. Sends and searches are rate limited per
 * user. Tokens never leave the server.
 */

export interface NotionDeps {
  db: Db;
  /** The Better Auth instance (its secret config encrypts tokens). */
  auth: SecretSource;
  /** `null` = Notion not configured on this server. */
  config: NotionConfig | null;
  /** Public origin of the app (`BETTER_AUTH_URL`): OAuth redirect URI and links back to notes. */
  appUrl: string;
  /** Signs the OAuth state cookie (the auth secret). */
  stateSecret: string;
  rateLimiter: RateLimiter;
  fetch?: FetchLike;
}

export const NOTION_LIMITS = {
  send: { max: 10, windowSec: 60 },
  search: { max: 60, windowSec: 60 },
} as const;

/** A push holds its (document, connection) row this long; a crashed push frees it after that. */
const LEASE_MS = 2 * 60_000;

export const NOTION_STATE_COOKIE = 'oat_notion_oauth';
export const NOTION_CALLBACK_PATH = '/api/integrations/notion/callback';
const STATE_TTL_SEC = 10 * 60;

const Settings = z.object({
  notionWorkspaceId: z.string().optional(),
  notionWorkspaceName: z.string().nullish(),
  notionWorkspaceIcon: z.string().nullish(),
  botId: z.string().optional(),
  targetType: z.enum(['page', 'database']).nullish(),
  targetId: z.string().nullish(),
  targetTitle: z.string().nullish(),
  targetUrl: z.string().nullish(),
  /** Notion answered 401 (revoked) or the token no longer decrypts. */
  needsReconnect: z.boolean().optional(),
  /** Post-meeting pipeline (8.3): send each meeting's notes here when it ends ("Auto-send", off by default). */
  autoPush: z.boolean().optional(),
});
type Settings = z.infer<typeof Settings>;

type IntegrationRow = typeof integration.$inferSelect;

function settingsOf(row: IntegrationRow): Settings {
  const parsed = Settings.safeParse(row.settingsJson);
  return parsed.success ? parsed.data : {};
}

const notConfigured = () =>
  new ApiError(503, 'not_configured', 'Notion isn’t set up on this server.');
const notConnected = () =>
  new ApiError(409, 'notion_not_connected', 'Connect Notion in Settings → Integrations first.');
const noTarget = () =>
  new ApiError(
    409,
    'notion_no_target',
    'Choose a Notion page or database to send notes to in Settings → Integrations.',
  );
const reconnect = () =>
  new ApiError(
    409,
    'notion_reconnect',
    'Oat can no longer reach your Notion workspace. Reconnect Notion in Settings → Integrations.',
  );

async function limit(deps: NotionDeps, key: string, rule: { max: number; windowSec: number }) {
  const hit = await deps.rateLimiter.hit(key, rule.max, rule.windowSec);
  if (!hit.allowed) {
    throw new ApiError(429, 'rate_limited', 'Too many requests to Notion. Try again in a minute.', {
      retryAfter: hit.retryAfter,
    });
  }
}

function requireConfig(deps: NotionDeps): NotionConfig {
  if (!deps.config) throw notConfigured();
  return deps.config;
}

function requireMember(actor: Actor, workspaceId: string) {
  // Same answer for "no such workspace" and "not a member": no existence leak.
  if (!roleIn(actor.ctx, workspaceId)) throw notFound('Workspace');
}

async function findIntegration(
  db: Db,
  userId: string,
  workspaceId: string,
): Promise<IntegrationRow | undefined> {
  const [row] = await db
    .select()
    .from(integration)
    .where(
      and(
        eq(integration.userId, userId),
        eq(integration.workspaceId, workspaceId),
        eq(integration.provider, 'notion'),
      ),
    );
  return row;
}

async function patchSettings(db: Db, row: IntegrationRow, patch: Partial<Settings>) {
  const next = { ...settingsOf(row), ...patch };
  await db.update(integration).set({ settingsJson: next }).where(eq(integration.id, row.id));
  return next;
}

function toInfo(row: IntegrationRow, settings = settingsOf(row)): NotionConnectionInfo {
  return {
    workspaceId: row.workspaceId,
    notionWorkspaceName: settings.notionWorkspaceName ?? null,
    notionWorkspaceIcon: settings.notionWorkspaceIcon ?? null,
    connectedAt: row.createdAt.toISOString(),
    needsReconnect: settings.needsReconnect === true || !row.secretEncrypted,
    target:
      settings.targetType && settings.targetId
        ? {
            type: settings.targetType,
            id: settings.targetId,
            title: settings.targetTitle ?? '',
            url: settings.targetUrl ?? null,
          }
        : null,
  };
}

/** The user's Notion connection for a workspace (for settings and the document page). */
export async function getNotionConnection(
  deps: NotionDeps,
  actor: Actor,
  workspaceId: string,
): Promise<NotionConnectionInfo | null> {
  requireMember(actor, workspaceId);
  const row = await findIntegration(deps.db, actor.userId, workspaceId);
  return row ? toInfo(row) : null;
}

/** A client with the user's token; a token that no longer decrypts flags the connection for reconnect. */
async function clientFor(deps: NotionDeps, row: IntegrationRow): Promise<NotionClient> {
  const config = requireConfig(deps);
  if (!row.secretEncrypted || settingsOf(row).needsReconnect) throw reconnect();
  let token: string;
  try {
    token = await decryptSecret(deps.auth, row.secretEncrypted);
  } catch {
    await patchSettings(deps.db, row, { needsReconnect: true });
    throw reconnect();
  }
  return new NotionClient({ baseUrl: config.baseUrl, token, fetch: deps.fetch });
}

/** Maps Notion failures to API errors; a 401 marks the connection for reconnect. */
async function notionFailure(
  deps: NotionDeps,
  row: IntegrationRow,
  error: unknown,
): Promise<never> {
  if (error instanceof NotionAuthError) {
    await patchSettings(deps.db, row, { needsReconnect: true });
    throw reconnect();
  }
  if (error instanceof NotionApiError) {
    if (error.status === 429) {
      throw new ApiError(429, 'rate_limited', 'Notion is busy right now. Try again in a minute.');
    }
    throw new ApiError(502, 'notion_error', `Notion refused the request: ${error.message}`);
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'TypeError')) {
    throw new ApiError(502, 'notion_error', 'Couldn’t reach Notion. Try again.');
  }
  throw error;
}

// ---------------------------------------------------------------------------------------------------
// OAuth connect

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** `state.workspaceId.signature`; the signature binds both to the user who started the flow. */
function stateCookieValue(deps: NotionDeps, userId: string, state: string, workspaceId: string) {
  return `${state}.${workspaceId}.${sign(deps.stateSecret, `notion:${userId}:${state}:${workspaceId}`)}`;
}

export interface ConnectStart {
  url: string;
  cookie: { name: string; value: string; maxAge: number; path: string; secure: boolean };
}

/** Starts "Connect Notion" for a workspace: the authorize URL and the state cookie to set. */
export function startNotionConnect(
  deps: NotionDeps,
  actor: Actor,
  workspaceId: string,
): ConnectStart {
  const config = requireConfig(deps);
  requireMember(actor, workspaceId);
  const state = randomBytes(18).toString('base64url');
  return {
    url: notionAuthorizeUrl(config, {
      redirectUri: new URL(NOTION_CALLBACK_PATH, deps.appUrl).toString(),
      state,
    }),
    cookie: {
      name: NOTION_STATE_COOKIE,
      value: stateCookieValue(deps, actor.userId, state, workspaceId),
      maxAge: STATE_TTL_SEC,
      path: '/api/integrations/notion',
      secure: deps.appUrl.startsWith('https://'),
    },
  };
}

export type ConnectErrorCode = 'denied' | 'state' | 'exchange' | 'not_configured';

export class NotionConnectError extends Error {
  override name = 'NotionConnectError';
  constructor(readonly code: ConnectErrorCode) {
    super(code);
  }
}

/**
 * Completes the OAuth callback: checks `state` against the signed cookie (same user, same flow), exchanges
 * the code and stores the encrypted token. Reconnecting the same Notion workspace keeps the chosen target.
 * Returns the Oat workspace id.
 */
export async function completeNotionConnect(
  deps: NotionDeps,
  actor: Actor,
  params: { code?: string | null; state?: string | null; error?: string | null; cookie?: string },
): Promise<string> {
  const config = deps.config;
  if (!config) throw new NotionConnectError('not_configured');
  const [state, workspaceId, signature] = (params.cookie ?? '').split('.');
  const expected =
    state && workspaceId
      ? stateCookieValue(deps, actor.userId, state, workspaceId).split('.')[2]!
      : '';
  const given = Buffer.from(signature ?? '');
  const wanted = Buffer.from(expected);
  const valid =
    given.length > 0 &&
    given.length === wanted.length &&
    timingSafeEqual(given, wanted) &&
    params.state === state;
  if (!valid || !workspaceId) throw new NotionConnectError('state');
  if (params.error) throw new NotionConnectError('denied');
  if (!params.code) throw new NotionConnectError('exchange');
  if (!roleIn(actor.ctx, workspaceId)) throw new NotionConnectError('state');

  let token;
  try {
    token = await exchangeNotionCode(
      { ...config, fetch: deps.fetch },
      { code: params.code, redirectUri: new URL(NOTION_CALLBACK_PATH, deps.appUrl).toString() },
    );
  } catch (error) {
    console.error('notion: token exchange failed:', error instanceof Error ? error.message : error);
    throw new NotionConnectError('exchange');
  }
  const secretEncrypted = await encryptSecret(deps.auth, token.access_token);
  const existing = await findIntegration(deps.db, actor.userId, workspaceId);
  const previous = existing ? settingsOf(existing) : {};
  const sameWorkspace = previous.notionWorkspaceId === token.workspace_id;
  const settings: Settings = {
    notionWorkspaceId: token.workspace_id,
    notionWorkspaceName: token.workspace_name ?? null,
    notionWorkspaceIcon: token.workspace_icon ?? null,
    botId: token.bot_id,
    ...(sameWorkspace
      ? {
          targetType: previous.targetType ?? null,
          targetId: previous.targetId ?? null,
          targetTitle: previous.targetTitle ?? null,
          targetUrl: previous.targetUrl ?? null,
          // A reconnect to the same Notion workspace keeps the auto-send choice (8.3).
          ...(previous.autoPush !== undefined ? { autoPush: previous.autoPush } : {}),
        }
      : {}),
  };
  await deps.db
    .insert(integration)
    .values({
      workspaceId,
      userId: actor.userId,
      provider: 'notion',
      secretEncrypted,
      settingsJson: settings,
    })
    .onConflictDoUpdate({
      target: [integration.workspaceId, integration.userId, integration.provider],
      set: { secretEncrypted, settingsJson: settings, updatedAt: new Date() },
    });
  return workspaceId;
}

/**
 * Disconnect: best-effort revoke at Notion, then delete the row (and with it the export mapping). Only ever the
 * user's own row, so no membership check: someone removed from the workspace can still revoke their token.
 */
export async function disconnectNotion(deps: NotionDeps, actor: Actor, workspaceId: string) {
  const row = await findIntegration(deps.db, actor.userId, workspaceId);
  if (!row) return;
  if (deps.config && row.secretEncrypted) {
    const token = await decryptSecret(deps.auth, row.secretEncrypted).catch(() => undefined);
    if (token) await revokeNotionToken({ ...deps.config, fetch: deps.fetch }, token);
  }
  await deps.db.delete(integration).where(eq(integration.id, row.id));
}

// ---------------------------------------------------------------------------------------------------
// Target

/** Links we render come from Notion: only http(s), so a bad answer can't become a `javascript:` href. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function toOption(obj: NotionPage | NotionDatabase): NotionTargetOption {
  const icon = obj.icon?.type === 'emoji' ? (obj.icon.emoji ?? null) : null;
  return {
    type: obj.object === 'database' ? 'database' : 'page',
    id: obj.id,
    title: notionTitle(obj) || 'Untitled',
    icon,
    url: safeUrl(obj.url),
  };
}

/** Pages and databases the connection can see (Notion search), for the target picker. */
export async function searchNotionTargets(
  deps: NotionDeps,
  actor: Actor,
  workspaceId: string,
  query: string,
): Promise<NotionTargetOption[]> {
  requireMember(actor, workspaceId);
  const row = await findIntegration(deps.db, actor.userId, workspaceId);
  if (!row) throw notConnected();
  await limit(deps, `notion:search:${actor.userId}`, NOTION_LIMITS.search);
  const client = await clientFor(deps, row);
  try {
    const page = await client.search({
      query: query.trim() || undefined,
      page_size: 25,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });
    return (
      page.results
        .filter((r) => !r.archived && !r.in_trash)
        // Database rows are pages too; as a destination they would only confuse.
        .filter((r) => r.object === 'database' || r.parent.type !== 'database_id')
        .map(toOption)
    );
  } catch (error) {
    return notionFailure(deps, row, error);
  }
}

/** Sets where new notes go, after checking the connection can see it (and reading its title). */
export async function setNotionTarget(
  deps: NotionDeps,
  actor: Actor,
  workspaceId: string,
  target: { type: 'page' | 'database'; id: string },
): Promise<NotionConnectionInfo> {
  requireMember(actor, workspaceId);
  const row = await findIntegration(deps.db, actor.userId, workspaceId);
  if (!row) throw notConnected();
  const client = await clientFor(deps, row);
  let found: NotionPage | NotionDatabase;
  try {
    found =
      target.type === 'database'
        ? await client.retrieveDatabase(target.id)
        : await client.retrievePage(target.id);
  } catch (error) {
    if (error instanceof NotionApiError && !(error instanceof NotionAuthError)) {
      if (error.isNotFound() || error.status === 400) {
        throw badRequest('That page or database isn’t shared with Oat in Notion.');
      }
    }
    return notionFailure(deps, row, error);
  }
  if (found.archived || found.in_trash) throw badRequest('That Notion page is in the trash.');
  const option = toOption(found);
  const settings = await patchSettings(deps.db, row, {
    targetType: option.type,
    targetId: option.id,
    targetTitle: option.title,
    targetUrl: option.url,
  });
  return toInfo(row, settings);
}

// ---------------------------------------------------------------------------------------------------
// Send a note

async function noteMeta(deps: NotionDeps, doc: { id: string; title: string; createdAt: string }) {
  const [m] = await deps.db.select().from(meeting).where(eq(meeting.documentId, doc.id));
  const people = m
    ? await deps.db
        .select({ name: participant.name, email: participant.email })
        .from(participant)
        .where(eq(participant.meetingId, m.id))
        .orderBy(asc(participant.createdAt))
    : [];
  return {
    title: doc.title,
    date: m?.startedAt ?? new Date(doc.createdAt),
    // Names only: third parties' email addresses never leave Oat (an email-only attendee shows its local part).
    attendees: people.map((p) => p.name.trim() || (p.email?.split('@')[0] ?? '')).filter(Boolean),
    oatUrl: new URL(`/d/${doc.id}`, deps.appUrl).toString(),
  };
}

async function exportRow(db: Db, documentId: string, integrationId: string) {
  const [row] = await db
    .select()
    .from(documentExport)
    .where(
      and(
        eq(documentExport.documentId, documentId),
        eq(documentExport.integrationId, integrationId),
      ),
    );
  return row;
}

/** Status for the document page's "Send to Notion" control. */
export async function getNotionDocumentStatus(
  deps: NotionDeps,
  actor: Actor,
  documentId: string,
): Promise<NotionDocumentStatus> {
  const doc = await getDocument(deps.db, actor, documentId);
  if (!deps.config) {
    return { configured: false, connection: null, export: null };
  }
  const row = await findIntegration(deps.db, actor.userId, doc.workspaceId);
  if (!row) return { configured: true, connection: null, export: null };
  const exp = await exportRow(deps.db, doc.id, row.id);
  return {
    configured: true,
    connection: toInfo(row),
    export:
      exp?.externalId && exp.pushedAt
        ? {
            url: exp.externalUrl,
            pushedAt: exp.pushedAt.toISOString(),
            pushedVersion: exp.pushedVersion ?? 0,
            changedSince: doc.version > (exp.pushedVersion ?? 0),
          }
        : null,
  };
}

/**
 * Sends the note to Notion: creates a page in the chosen target the first time, then updates that same
 * page (properties + content replaced). One push per (note, connection) at a time.
 */
export async function sendToNotion(
  deps: NotionDeps,
  actor: Actor,
  documentId: string,
  options: { timeZone?: string } = {},
): Promise<NotionPushResult> {
  requireConfig(deps);
  const doc = await getDocument(deps.db, actor, documentId);
  if (doc.deletedAt) throw badRequest('Restore this note from the trash before sending it.');
  const row = await findIntegration(deps.db, actor.userId, doc.workspaceId);
  if (!row) throw notConnected();
  const settings = settingsOf(row);
  if (!settings.targetType || !settings.targetId) throw noTarget();
  await limit(deps, `notion:send:${actor.userId}`, NOTION_LIMITS.send);
  const client = await clientFor(deps, row);

  // Take the lease (insert, or take over a free/expired one), under a fresh lease id.
  const leaseId = randomBytes(12).toString('base64url');
  const leaseUntil = () => new Date(Date.now() + LEASE_MS);
  const [lease] = await deps.db
    .insert(documentExport)
    .values({ documentId: doc.id, integrationId: row.id, leaseId, leaseUntil: leaseUntil() })
    .onConflictDoUpdate({
      target: [documentExport.documentId, documentExport.integrationId],
      set: { leaseId, leaseUntil: leaseUntil(), updatedAt: new Date() },
      setWhere: or(isNull(documentExport.leaseUntil), lt(documentExport.leaseUntil, sql`now()`)),
    })
    .returning();
  if (!lease) throw busy();

  /** Writes to our row only while we still hold the lease (compare-and-set on `lease_id`). */
  const fenced = async (values: Partial<typeof documentExport.$inferInsert>) => {
    const updated = await deps.db
      .update(documentExport)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(documentExport.id, lease.id), eq(documentExport.leaseId, leaseId)))
      .returning({ id: documentExport.id });
    if (updated.length === 0) throw new LeaseLostError();
  };

  try {
    const result = await pushNote({
      client,
      target: { type: settings.targetType, id: settings.targetId },
      existingPageId: lease.externalId,
      ownedBlockIds: lease.blockIds,
      doc: doc.contentJson,
      meta: await noteMeta(deps, doc),
      baseUrl: deps.appUrl,
      timeZone: options.timeZone,
      // Renew the lease and record what is on the page before/after every write.
      checkpoint: (state) =>
        fenced({
          externalId: state.page.id,
          externalUrl: safeUrl(state.page.url),
          blockIds: state.blockIds,
          leaseUntil: leaseUntil(),
        }),
    });
    const pushedAt = new Date();
    const url = safeUrl(result.url);
    await fenced({
      externalId: result.pageId,
      externalUrl: url,
      blockIds: result.blockIds,
      pushedVersion: doc.version,
      pushedAt,
      leaseId: null,
      leaseUntil: null,
    });
    return {
      url: url ?? '',
      created: result.created,
      pushedAt: pushedAt.toISOString(),
      pushedVersion: doc.version,
    };
  } catch (error) {
    if (error instanceof LeaseLostError) throw busy();
    // Release only our own lease (another push may hold it by now).
    await fenced({ leaseId: null, leaseUntil: null }).catch(() => undefined);
    if (error instanceof NotionTargetMissingError) {
      // Creating in the chosen page/database failed: it is gone or no longer shared.
      await patchSettings(deps.db, row, {
        targetType: null,
        targetId: null,
        targetTitle: null,
        targetUrl: null,
      });
      throw new ApiError(
        409,
        'notion_no_target',
        'The Notion page or database you chose is no longer shared with Oat. Choose another in Settings → Integrations.',
      );
    }
    return notionFailure(deps, row, error);
  }
}

class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}

const busy = () =>
  new ApiError(
    409,
    'notion_busy',
    'This note is already being sent to Notion. Try again in a moment.',
  );
