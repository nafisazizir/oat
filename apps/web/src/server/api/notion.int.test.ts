/**
 * Notion integration (8.1) through the exact route handlers, against a throwaway database, an in-process
 * Better Auth and an in-process Notion mock (`startMocks()`, real HTTP): connect (OAuth state, encrypted token),
 * choose a target, push, re-push replaces the content of the same page, token revoked → reconnect error,
 * disconnect, and the deny cases (anonymous, cross-site, non-member, unreadable note, rate limit, busy).
 */
import { createMemoryRateLimiter, findFirstWorkspaceId, type RateLimiter } from '@oat/auth';
import { documentExport, integration, meeting, membership, participant } from '@oat/db';
import { NOTION_MOCK_IDS, notionProvider, type RunningMocks, startMocks } from '@oat/mocks';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  DocumentDetail,
  NotionConnectionInfo,
  NotionDocumentStatus,
  NotionPushResult,
  NotionTargetOption,
} from '@/lib/api-types';

import type { NotionDeps } from '../notion';
import { denies } from './authz-markers';
import { createNotionApi, type NotionApi } from './notion';
import {
  BASE,
  call,
  type CallOptions,
  createHarness,
  type Harness,
  type TestUser,
} from './test-harness';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let h: Harness;
let mocks: RunningMocks;
let api: NotionApi;
let limiter: RateLimiter;
/** Intercepts the server's calls to Notion (race tests). */
let fetchHook: ((input: string, init?: RequestInit) => Promise<Response>) | null = null;
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let team: string;
let ownerOwnWs: string;

beforeAll(async () => {
  [h, mocks] = await Promise.all([
    createHarness(),
    startMocks({ providers: [() => notionProvider()] }),
  ]);
  limiter = createMemoryRateLimiter();
  const deps = (): NotionDeps => ({
    db: h.db,
    auth: h.auth,
    config: {
      baseUrl: `${mocks.url}/notion`,
      clientId: 'oat-dev',
      clientSecret: 'oat-dev-secret',
      mode: 'mock',
    },
    appUrl: BASE,
    stateSecret: 'test-state-secret-0123456789abcdef',
    rateLimiter: limiter,
    fetch: (input, init) => (fetchHook ? fetchHook(String(input), init) : fetch(input, init)),
  });
  api = createNotionApi(
    {
      db: () => h.db,
      getSession: (headers) => h.auth.api.getSession({ headers }),
      allowedOrigins: () => [BASE],
    },
    deps,
  );
  [owner, member, viewer, outsider] = await Promise.all([
    h.signUp('n-owner'),
    h.signUp('n-member'),
    h.signUp('n-viewer'),
    h.signUp('n-outsider'),
  ]);
  team = await h.teamWorkspace(owner, [
    [member, 'member'],
    [viewer, 'viewer'],
  ]);
  ownerOwnWs = (await findFirstWorkspaceId(h.db, owner.id))!;
}, 60_000);

afterAll(async () => {
  await mocks?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------------------------------
// Helpers

/** POST /connect as a form, as the browser does; returns the redirect and the state cookie. */
async function startConnect(as: TestUser, workspaceId: string, origin = BASE) {
  const res = await api.connect.POST(
    new Request(`${BASE}/api/integrations/notion/connect`, {
      method: 'POST',
      headers: {
        cookie: as.cookie,
        origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ workspaceId }).toString(),
    }),
    { params: Promise.resolve({}) },
  );
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('oat_notion_oauth='));
  return { res, location: res.headers.get('location'), stateCookie: setCookie?.split(';')[0] };
}

async function callback(as: TestUser | null, query: string, stateCookie?: string) {
  const cookie = [as?.cookie, stateCookie].filter(Boolean).join('; ');
  const res = await api.callback.GET(
    new Request(`${BASE}/api/integrations/notion/callback?${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, location: new URL(res.headers.get('location')!) };
}

/** The full consent round-trip through the mock (auto-approves). */
async function connect(as: TestUser, workspaceId: string) {
  const { location, stateCookie } = await startConnect(as, workspaceId);
  const consent = await fetch(location!, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(`${BASE}/api/integrations/notion/callback`);
  return callback(as, back.searchParams.toString(), stateCookie);
}

const connection = (as: TestUser, workspaceId: string) =>
  call<NotionConnectionInfo | null>(
    api.connection.GET,
    'GET',
    `/api/integrations/notion?workspaceId=${workspaceId}`,
    { as },
  );
const targets = (as: TestUser | null, workspaceId: string, q = '') =>
  call<NotionTargetOption[]>(
    api.targets.GET,
    'GET',
    `/api/integrations/notion/targets?workspaceId=${workspaceId}&q=${encodeURIComponent(q)}`,
    { as },
  );
const setTarget = (as: TestUser, body: unknown, opts: Partial<CallOptions> = {}) =>
  call<NotionConnectionInfo>(api.target.PUT, 'PUT', '/api/integrations/notion/target', {
    as,
    body,
    ...opts,
  });
const status = (as: TestUser | null, id: string) =>
  call<NotionDocumentStatus>(api.document.GET, 'GET', `/api/documents/${id}/notion`, {
    as,
    params: { id },
  });
const send = (as: TestUser | null, id: string, opts: Partial<CallOptions> = {}) =>
  call<NotionPushResult>(api.document.POST, 'POST', `/api/documents/${id}/notion`, {
    as,
    params: { id },
    body: { timeZone: 'Europe/London' },
    ...opts,
  });

async function createDoc(as: TestUser, body: Record<string, unknown>): Promise<DocumentDetail> {
  const res = await call<DocumentDetail>(h.api.documents.POST, 'POST', '/api/documents', {
    as,
    body,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.body;
}

const paragraphs = (...texts: string[]) => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const tree = async (pageId: string) =>
  (await (await fetch(`${mocks.url}/notion/_mock/pages/${pageId}/tree`)).json()) as Json;
const pageIdOf = (url: string) => url.split('/').at(-1)!;
const textOf = (block: Json): string =>
  ((block[block.type]?.rich_text ?? []) as Json[]).map((r) => r.plain_text).join('');

async function integrationRow(userId: string, workspaceId: string) {
  const rows = await h.db.select().from(integration).where(eq(integration.userId, userId));
  return rows.find((r) => r.workspaceId === workspaceId && r.provider === 'notion');
}

// ---------------------------------------------------------------------------------------------------

describe('connect (OAuth)', () => {
  it('redirects to Notion with a signed state, stores the encrypted token on return', async () => {
    const { res, location, stateCookie } = await startConnect(owner, ownerOwnWs);
    expect(res.status).toBe(303);
    const authorize = new URL(location!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      `${mocks.url}/notion/v1/oauth/authorize`,
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'oat-dev',
      response_type: 'code',
      owner: 'user',
      redirect_uri: `${BASE}/api/integrations/notion/callback`,
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('oat_notion_oauth='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/integrations\/notion/);
    expect(stateCookie).toContain(authorize.searchParams.get('state')!);

    const done = await connect(owner, ownerOwnWs);
    expect(done.status).toBe(303);
    expect(done.location.pathname).toBe('/settings/integrations');
    expect(done.location.searchParams.get('connected')).toBe('notion');

    const row = await integrationRow(owner.id, ownerOwnWs);
    expect(row?.secretEncrypted).toBeTruthy();
    expect(row!.secretEncrypted).not.toContain('ntn_mock_');
    expect(row!.settingsJson).toMatchObject({
      notionWorkspaceId: NOTION_MOCK_IDS.workspace,
      notionWorkspaceName: 'Oat Mock Notion',
      botId: NOTION_MOCK_IDS.bot,
    });
    const info = await connection(owner, ownerOwnWs);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      workspaceId: ownerOwnWs,
      notionWorkspaceName: 'Oat Mock Notion',
      needsReconnect: false,
      target: null,
    });
    expect(JSON.stringify(info.body)).not.toContain('ntn_');
    // The token exchange used HTTP Basic client auth and the same redirect URI.
    const exchange = mocks.log
      .list({ provider: 'notion' })
      .findLast((r) => r.path === '/notion/v1/oauth/token');
    expect(exchange?.headers.authorization).toBe('Basic [redacted]');
    expect(JSON.parse(exchange!.body!)).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: `${BASE}/api/integrations/notion/callback`,
    });
  });

  it('rejects a bad or foreign state, a denied consent and a cross-site start', async () => {
    denies('GET /api/integrations/notion/callback', 'POST /api/integrations/notion/connect');
    const { location, stateCookie } = await startConnect(member, team);
    const state = new URL(location!).searchParams.get('state')!;
    // Wrong state value.
    expect(
      (await callback(member, `code=x&state=nope`, stateCookie)).location.searchParams.get(
        'notion_error',
      ),
    ).toBe('state');
    // No cookie.
    expect(
      (await callback(member, `code=x&state=${state}`)).location.searchParams.get('notion_error'),
    ).toBe('state');
    // Another user's session with this user's cookie.
    expect(
      (await callback(viewer, `code=x&state=${state}`, stateCookie)).location.searchParams.get(
        'notion_error',
      ),
    ).toBe('state');
    // The user said no at Notion.
    const denied = await callback(member, `error=access_denied&state=${state}`, stateCookie);
    expect(denied.location.searchParams.get('notion_error')).toBe('denied');
    // A made-up code.
    const bad = await callback(member, `code=forged&state=${state}`, stateCookie);
    expect(bad.location.searchParams.get('notion_error')).toBe('exchange');
    expect(await integrationRow(member.id, team)).toBeUndefined();
    // Signed out → sign in first.
    const anon = await api.callback.GET(
      new Request(`${BASE}/api/integrations/notion/callback?code=x&state=${state}`, {
        headers: { cookie: stateCookie! },
      }),
      { params: Promise.resolve({}) },
    );
    expect(anon.status).toBe(401);

    const evil = await startConnect(member, team, 'https://evil.example');
    expect(evil.res.status).toBe(403);
  });

  it('refuses workspaces the user isn’t a member of', async () => {
    denies(
      'POST /api/integrations/notion/connect',
      'GET /api/integrations/notion',
      'GET /api/integrations/notion/targets',
      'PUT /api/integrations/notion/target',
    );
    const { res } = await startConnect(outsider, team);
    expect(res.status).toBe(404);
    expect((await connection(outsider, team)).status).toBe(404);
    expect((await targets(outsider, team)).status).toBe(404);
    const target = await setTarget(outsider, {
      workspaceId: team,
      type: 'page',
      id: NOTION_MOCK_IDS.teamHome,
    });
    expect(target.status).toBe(404);
  });
});

describe('target', () => {
  it('searches pages and databases (no database rows) and stores the chosen target', async () => {
    const all = await targets(owner, ownerOwnWs);
    expect(all.status).toBe(200);
    expect(all.body.map((t) => [t.type, t.title])).toEqual(
      expect.arrayContaining([
        ['page', 'Team Home'],
        ['page', 'Meeting notes'],
        ['database', 'Meetings'],
        ['database', 'Reading list'],
      ]),
    );
    const meet = await targets(owner, ownerOwnWs, 'meet');
    expect(meet.body.map((t) => t.title).sort()).toEqual(['Meeting notes', 'Meetings']);

    const set = await setTarget(owner, {
      workspaceId: ownerOwnWs,
      type: 'page',
      id: NOTION_MOCK_IDS.meetingNotes,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    expect(set.body.target).toMatchObject({
      type: 'page',
      id: NOTION_MOCK_IDS.meetingNotes,
      title: 'Meeting notes',
    });

    // Wrong type for the id, unknown id, malformed id, cross-site.
    expect(
      (
        await setTarget(owner, {
          workspaceId: ownerOwnWs,
          type: 'database',
          id: NOTION_MOCK_IDS.teamHome,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await setTarget(owner, {
          workspaceId: ownerOwnWs,
          type: 'page',
          id: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(400);
    expect(
      (await setTarget(owner, { workspaceId: ownerOwnWs, type: 'page', id: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await setTarget(
          owner,
          { workspaceId: ownerOwnWs, type: 'page', id: NOTION_MOCK_IDS.scratchpad },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await connection(owner, ownerOwnWs)).body?.target?.id).toBe(
      NOTION_MOCK_IDS.meetingNotes,
    );
  });

  it('needs a connection and a session', async () => {
    expect((await targets(null, ownerOwnWs)).status).toBe(401);
    const none = await targets(viewer, team);
    expect(none.status).toBe(409);
    expect(none.error?.code).toBe('notion_not_connected');
  });
});

describe('send to Notion', () => {
  it('creates the page, then re-sending replaces its content (same page)', async () => {
    const doc = await createDoc(owner, {
      workspaceId: ownerOwnWs,
      title: 'Kickoff notes',
      contentJson: paragraphs('First version', 'Second paragraph'),
    });
    const before = await status(owner, doc.id);
    expect(before.body).toMatchObject({
      configured: true,
      export: null,
      connection: { target: { title: 'Meeting notes' } },
    });

    const first = await send(owner, doc.id);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.body).toMatchObject({ created: true, pushedVersion: doc.version });
    const page = await tree(pageIdOf(first.body.url));
    expect(page.title).toBe('Kickoff notes');
    expect(page.parent).toEqual({ type: 'page_id', page_id: NOTION_MOCK_IDS.meetingNotes });
    expect(page.children.map(textOf)).toEqual([
      expect.stringContaining('Open in Oat'),
      '',
      'First version',
      'Second paragraph',
    ]);
    expect(page.children[0].paragraph.rich_text.at(-1).href).toBe(`${BASE}/d/${doc.id}`);

    const after = await status(owner, doc.id);
    expect(after.body.export).toMatchObject({ url: first.body.url, changedSince: false });

    // Edit the note in Oat, send again: same Notion page, new content, new title.
    const patched = await call<DocumentDetail>(
      h.api.document.PATCH,
      'PATCH',
      `/api/documents/${doc.id}`,
      {
        as: owner,
        params: { id: doc.id },
        body: {
          baseVersion: doc.version,
          title: 'Kickoff notes v2',
          contentJson: paragraphs('Rewritten'),
        },
      },
    );
    expect(patched.status).toBe(200);
    expect((await status(owner, doc.id)).body.export?.changedSince).toBe(true);
    const second = await send(owner, doc.id);
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(second.body).toMatchObject({
      created: false,
      url: first.body.url,
      pushedVersion: patched.body.version,
    });
    const replaced = await tree(pageIdOf(first.body.url));
    expect(replaced.title).toBe('Kickoff notes v2');
    expect(replaced.children.map(textOf).slice(2)).toEqual(['Rewritten']);
    expect((await status(owner, doc.id)).body.export?.changedSince).toBe(false);
  });

  it('fills database properties from the meeting (date, attendees, Oat link)', async () => {
    await setTarget(owner, {
      workspaceId: ownerOwnWs,
      type: 'database',
      id: NOTION_MOCK_IDS.meetingsDb,
    });
    const doc = await createDoc(owner, {
      workspaceId: ownerOwnWs,
      kind: 'meeting',
      title: 'Design review',
      contentJson: paragraphs('Decisions'),
    });
    const [m] = await h.db
      .insert(meeting)
      .values({ documentId: doc.id, startedAt: new Date('2026-11-16T17:00:00Z') })
      .returning();
    await h.db.insert(participant).values([
      { meetingId: m!.id, name: 'Ada Lovelace', source: 'calendar' },
      { meetingId: m!.id, name: 'Grace Hopper', email: 'grace@example.test', source: 'manual' },
      { meetingId: m!.id, name: ' ', email: 'linus@example.test', source: 'calendar' },
    ]);
    const res = await send(owner, doc.id);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const page = await tree(pageIdOf(res.body.url));
    expect(page.parent).toEqual({ type: 'database_id', database_id: NOTION_MOCK_IDS.meetingsDb });
    expect(page.properties).toMatchObject({
      Name: { title: [{ plain_text: 'Design review' }] },
      Date: { date: { start: '2026-11-16T17:00:00.000Z' } },
      Attendees: { rich_text: [{ plain_text: 'Ada Lovelace, Grace Hopper, linus' }] },
      'Oat link': { url: `${BASE}/d/${doc.id}` },
    });
    expect(page.children.map(textOf)).toEqual(['Decisions']);
    // No attendee email address ever reaches Notion.
    const sentBodies = mocks.log
      .list({ provider: 'notion' })
      .filter((r) => r.body?.includes(doc.id))
      .map((r) => r.body!);
    expect(sentBodies.length).toBeGreaterThan(0);
    expect(sentBodies.join('\n')).not.toContain('example.test');
  });

  it('lets a member send a shared note with their own connection; others are denied', async () => {
    denies('GET /api/documents/[id]/notion', 'POST /api/documents/[id]/notion');
    const shared = await createDoc(owner, {
      workspaceId: team,
      title: 'Team sync',
      visibility: 'workspace',
      contentJson: paragraphs('Shared'),
    });
    const ownersPrivate = await createDoc(owner, {
      workspaceId: team,
      title: 'Mine',
      contentJson: paragraphs('x'),
    });

    // Not connected yet in this workspace.
    const notConnected = await send(member, shared.id);
    expect(notConnected.status).toBe(409);
    expect(notConnected.error?.code).toBe('notion_not_connected');
    expect((await status(member, shared.id)).body).toMatchObject({
      configured: true,
      connection: null,
    });

    await connect(member, team);
    const noTarget = await send(member, shared.id);
    expect(noTarget.error?.code).toBe('notion_no_target');
    await setTarget(member, { workspaceId: team, type: 'page', id: NOTION_MOCK_IDS.teamHome });

    const sent = await send(member, shared.id);
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect((await tree(pageIdOf(sent.body.url))).parent).toEqual({
      type: 'page_id',
      page_id: NOTION_MOCK_IDS.teamHome,
    });
    // The export row belongs to the member's connection.
    const memberIntegration = await integrationRow(member.id, team);
    const exports = await h.db
      .select()
      .from(documentExport)
      .where(eq(documentExport.documentId, shared.id));
    expect(exports.map((e) => e.integrationId)).toEqual([memberIntegration!.id]);

    // Unreadable notes are 404s (no existence leak); anonymous is 401; cross-site is 403.
    expect((await send(member, ownersPrivate.id)).status).toBe(404);
    expect((await status(member, ownersPrivate.id)).status).toBe(404);
    expect((await send(outsider, shared.id)).status).toBe(404);
    expect((await send(null, shared.id)).status).toBe(401);
    expect((await send(member, shared.id, { origin: 'https://evil.example' })).status).toBe(403);
    // A viewer can read it, but has no connection.
    expect((await send(viewer, shared.id)).error?.code).toBe('notion_not_connected');
  });

  it('refuses trashed notes, concurrent sends and bad input', async () => {
    const doc = await createDoc(owner, {
      workspaceId: ownerOwnWs,
      title: 'Edge',
      contentJson: paragraphs('x'),
    });
    expect((await send(owner, doc.id, { body: { timeZone: 'Not/AZone' } })).status).toBe(400);
    expect((await send(owner, doc.id, { body: { extra: 1 } })).status).toBe(400);

    // Another send holds the lease.
    const row = await integrationRow(owner.id, ownerOwnWs);
    await h.db.insert(documentExport).values({
      documentId: doc.id,
      integrationId: row!.id,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const busy = await send(owner, doc.id);
    expect(busy.status).toBe(409);
    expect(busy.error?.code).toBe('notion_busy');
    // An expired lease is taken over.
    await h.db
      .update(documentExport)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(documentExport.documentId, doc.id));
    expect((await send(owner, doc.id)).status).toBe(200);

    await call(h.api.document.DELETE, 'DELETE', `/api/documents/${doc.id}`, {
      as: owner,
      params: { id: doc.id },
    });
    const trashed = await send(owner, doc.id);
    expect(trashed.status).toBe(400);
  });

  it('rate limits sends per user (429 + Retry-After)', async () => {
    const doc = await createDoc(owner, {
      workspaceId: ownerOwnWs,
      title: 'Rate',
      contentJson: paragraphs('x'),
    });
    for (let i = 0; i < 10; i++) await limiter.hit(`notion:send:${owner.id}`, 10, 60);
    const res = await api.document.POST(
      new Request(`${BASE}/api/documents/${doc.id}/notion`, {
        method: 'POST',
        headers: { cookie: owner.cookie, origin: BASE },
      }),
      { params: Promise.resolve({ id: doc.id }) },
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await res.json()) as Json).error.code).toBe('rate_limited');
  });
});

describe('revoked token and disconnect', () => {
  it('a token revoked in Notion gives a clear reconnect error; reconnecting fixes it', async () => {
    const user = await h.signUp('n-revoke');
    const ws = (await findFirstWorkspaceId(h.db, user.id))!;
    await connect(user, ws);
    await setTarget(user, { workspaceId: ws, type: 'page', id: NOTION_MOCK_IDS.scratchpad });
    const doc = await createDoc(user, {
      workspaceId: ws,
      title: 'Revoked',
      contentJson: paragraphs('x'),
    });
    expect((await send(user, doc.id)).status).toBe(200);

    // Revoke the stored token at the mock (as if the user removed Oat in Notion).
    const { decryptSecret } = await import('@oat/auth');
    const row = await integrationRow(user.id, ws);
    const token = await decryptSecret(h.auth, row!.secretEncrypted!);
    await fetch(`${mocks.url}/notion/_mock/revoke-token`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    const failed = await send(user, doc.id);
    expect(failed.status).toBe(409);
    expect(failed.error).toEqual({
      code: 'notion_reconnect',
      message:
        'Oat can no longer reach your Notion workspace. Reconnect Notion in Settings → Integrations.',
    });
    expect((await connection(user, ws)).body?.needsReconnect).toBe(true);
    expect((await targets(user, ws)).error?.code).toBe('notion_reconnect');

    // Reconnecting the same Notion workspace keeps the target and the page mapping.
    await connect(user, ws);
    const info = (await connection(user, ws)).body!;
    expect(info).toMatchObject({
      needsReconnect: false,
      target: { id: NOTION_MOCK_IDS.scratchpad },
    });
    const again = await send(user, doc.id);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it('disconnect revokes the token at Notion and removes the connection and its exports', async () => {
    const user = await h.signUp('n-disconnect');
    const ws = (await findFirstWorkspaceId(h.db, user.id))!;
    await connect(user, ws);
    await setTarget(user, { workspaceId: ws, type: 'page', id: NOTION_MOCK_IDS.scratchpad });
    const doc = await createDoc(user, {
      workspaceId: ws,
      title: 'Bye',
      contentJson: paragraphs('x'),
    });
    await send(user, doc.id);
    const row = await integrationRow(user.id, ws);

    // Someone else can't remove it: DELETE only ever touches the caller's own connection.
    denies('DELETE /api/integrations/notion');
    const foreign = await call(
      api.connection.DELETE,
      'DELETE',
      `/api/integrations/notion?workspaceId=${ws}`,
      { as: outsider },
    );
    expect(foreign.status).toBe(204);
    expect(await integrationRow(user.id, ws)).toBeDefined();

    const res = await call(
      api.connection.DELETE,
      'DELETE',
      `/api/integrations/notion?workspaceId=${ws}`,
      { as: user },
    );
    expect(res.status).toBe(204);
    expect(await integrationRow(user.id, ws)).toBeUndefined();
    expect(
      await h.db.select().from(documentExport).where(eq(documentExport.integrationId, row!.id)),
    ).toEqual([]);
    const revoke = mocks.log
      .list({ provider: 'notion' })
      .findLast((r) => r.path === '/notion/v1/oauth/revoke');
    expect(revoke?.status).toBe(200);
    expect((await connection(user, ws)).body).toBeNull();
    // Idempotent.
    expect(
      (
        await call(api.connection.DELETE, 'DELETE', `/api/integrations/notion?workspaceId=${ws}`, {
          as: user,
        })
      ).status,
    ).toBe(204);
  });

  it('a member removed from the workspace can still disconnect (revoke) their own token', async () => {
    const user = await h.signUp('n-removed');
    const ws = await h.teamWorkspace(owner, [[user, 'member']]);
    await connect(user, ws);
    await h.db
      .delete(membership)
      .where(and(eq(membership.workspaceId, ws), eq(membership.userId, user.id)));
    expect((await connection(user, ws)).status).toBe(404);
    const res = await call(
      api.connection.DELETE,
      'DELETE',
      `/api/integrations/notion?workspaceId=${ws}`,
      { as: user },
    );
    expect(res.status).toBe(204);
    expect(await integrationRow(user.id, ws)).toBeUndefined();
  });
});

describe('re-push safety', () => {
  async function connectedUser(label: string) {
    const user = await h.signUp(label);
    const ws = (await findFirstWorkspaceId(h.db, user.id))!;
    await connect(user, ws);
    await setTarget(user, { workspaceId: ws, type: 'page', id: NOTION_MOCK_IDS.scratchpad });
    return { user, ws };
  }
  const exportOf = async (documentId: string) =>
    (await h.db.select().from(documentExport).where(eq(documentExport.documentId, documentId)))[0]!;
  async function notionAs(
    user: TestUser,
    ws: string,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const { decryptSecret } = await import('@oat/auth');
    const token = await decryptSecret(
      h.auth,
      (await integrationRow(user.id, ws))!.secretEncrypted!,
    );
    const res = await fetch(`${mocks.url}/notion/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': '2022-06-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as Json;
  }

  it('stores the block ids it wrote and leaves the user’s sub-pages alone', async () => {
    const { user, ws } = await connectedUser('n-subpage');
    const doc = await createDoc(user, {
      workspaceId: ws,
      title: 'Owned',
      contentJson: paragraphs('v1'),
    });
    const first = await send(user, doc.id);
    const exp = await exportOf(doc.id);
    expect(exp.blockIds).toHaveLength(3);
    expect(exp.leaseId).toBeNull();
    // The user nests a follow-up page under the exported note in Notion.
    const sub = await notionAs(user, ws, 'POST', '/pages', {
      parent: { page_id: pageIdOf(first.body.url) },
      properties: { title: { title: [{ text: { content: 'Follow-up' } }] } },
    });
    await call(h.api.document.PATCH, 'PATCH', `/api/documents/${doc.id}`, {
      as: user,
      params: { id: doc.id },
      body: { baseVersion: doc.version, contentJson: paragraphs('v2') },
    });
    expect((await send(user, doc.id)).status).toBe(200);
    const page = await tree(pageIdOf(first.body.url));
    expect(page.children.map((b: Json) => b.type)).toEqual([
      'child_page',
      'paragraph',
      'divider',
      'paragraph',
    ]);
    expect(page.children[0].id).toBe(sub.id);
    expect(textOf(page.children.at(-1))).toBe('v2');
  });

  it('a page deleted in Notion gets a new page on re-push; the chosen target stays', async () => {
    const { user, ws } = await connectedUser('n-gone');
    const doc = await createDoc(user, {
      workspaceId: ws,
      title: 'Gone',
      contentJson: paragraphs('x'),
    });
    const first = await send(user, doc.id);
    await notionAs(user, ws, 'DELETE', `/blocks/${pageIdOf(first.body.url)}`);
    const second = await send(user, doc.id);
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(second.body.created).toBe(true);
    expect(second.body.url).not.toBe(first.body.url);
    expect((await connection(user, ws)).body?.target?.id).toBe(NOTION_MOCK_IDS.scratchpad);
  });

  it('a push that lost its lease stops, takes back its batch and leaves the new lease alone', async () => {
    const { user, ws } = await connectedUser('n-lease');
    const doc = await createDoc(user, {
      workspaceId: ws,
      title: 'Race',
      contentJson: paragraphs('Race v1'),
    });
    const first = await send(user, doc.id);
    const pageId = pageIdOf(first.body.url);
    const row = await exportOf(doc.id);

    // Push A pauses at its first append; meanwhile its lease expires, push B takes it over and finishes,
    // and then a third push C holds the lease.
    let b: Awaited<ReturnType<typeof send>> | undefined;
    fetchHook = async (input, init) => {
      if (init?.method === 'PATCH' && input.endsWith('/children')) {
        fetchHook = null;
        await h.db
          .update(documentExport)
          .set({ leaseUntil: new Date(Date.now() - 1000) })
          .where(eq(documentExport.id, row.id));
        b = await send(user, doc.id);
        await h.db
          .update(documentExport)
          .set({ leaseId: 'push-c', leaseUntil: new Date(Date.now() + 60_000) })
          .where(eq(documentExport.id, row.id));
      }
      return fetch(input, init);
    };
    const a = await send(user, doc.id);
    fetchHook = null;
    expect(b?.status, JSON.stringify(b?.error)).toBe(200);
    expect(a.status).toBe(409);
    expect(a.error?.code).toBe('notion_busy');
    // A neither released nor overwrote C's lease…
    expect((await exportOf(doc.id)).leaseId).toBe('push-c');
    // …and took back what it appended: the page holds B's content exactly once.
    const page = await tree(pageId);
    expect(page.children.map(textOf)).toEqual([
      expect.stringContaining('Open in Oat'),
      '',
      'Race v1',
    ]);
    await h.db
      .update(documentExport)
      .set({ leaseId: null, leaseUntil: null })
      .where(eq(documentExport.id, row.id));
  });
});
