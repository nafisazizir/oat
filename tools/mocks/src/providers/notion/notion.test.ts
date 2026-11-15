import { describe, expect, it } from 'vitest';

import { createApp } from '../../app.ts';
import { NOTION_API_VERSION, NOTION_MOCK_IDS, notionProvider } from './index.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TOKEN = 'ntn_mock_test';
const text = (content: string, extra: Json = {}) => ({ type: 'text', text: { content }, ...extra });
const para = (content: string, children?: Json[]) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [text(content)], ...(children ? { children } : {}) },
});
const bullet = (content: string, children?: Json[]) => ({
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: [text(content)], ...(children ? { children } : {}) },
});

function mock() {
  const { app, log } = createApp({ providers: [() => notionProvider()] });
  const call = async (
    method: string,
    path: string,
    init: { body?: unknown; token?: string | null; version?: string | null; headers?: Json } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? TOKEN}`);
    if (init.version !== null) headers.set('notion-version', init.version ?? NOTION_API_VERSION);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(`/notion${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const raw = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: (raw ? JSON.parse(raw) : null) as Json,
    };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, { body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const createPage = (body: Json) => ok('POST', '/v1/pages', body);
  const underNotes = (extra: Json = {}) => ({
    parent: { page_id: NOTION_MOCK_IDS.meetingNotes },
    properties: { title: { title: [text('Weekly sync')] } },
    ...extra,
  });
  return { app, log, call, ok, createPage, underNotes };
}

const basic = (id: string, secret = 'secret') =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('notion mock: OAuth', () => {
  async function authorize(app: ReturnType<typeof mock>['app'], query: string) {
    return app.request(`/notion/v1/oauth/authorize?${query}`);
  }
  const redirect = 'http://localhost:3000/api/integrations/notion/callback';
  const q = `client_id=oat-dev&response_type=code&owner=user&state=s1&redirect_uri=${encodeURIComponent(redirect)}`;

  async function token(app: ReturnType<typeof mock>['app'], body: Json, auth = basic('oat-dev')) {
    const res = await app.request('/notion/v1/oauth/token', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  it('auto-approves and exchanges the code once (Basic auth, matching redirect_uri)', async () => {
    const { app, call } = mock();
    const res = await authorize(app, q);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(redirect);
    expect(location.searchParams.get('state')).toBe('s1');
    const code = location.searchParams.get('code')!;

    const wrongUri = await token(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://x/cb',
    });
    expect(wrongUri).toEqual({
      status: 400,
      body: expect.objectContaining({ error: 'invalid_grant' }),
    });

    const again = await authorize(app, q);
    const code2 = new URL(again.headers.get('location')!).searchParams.get('code')!;
    const noBasic = await token(
      app,
      { grant_type: 'authorization_code', code: code2, redirect_uri: redirect },
      '',
    );
    expect(noBasic.status).toBe(401);
    expect(noBasic.body.error).toBe('invalid_client');

    const third = new URL((await authorize(app, q)).headers.get('location')!).searchParams.get(
      'code',
    )!;
    const good = await token(app, {
      grant_type: 'authorization_code',
      code: third,
      redirect_uri: redirect,
    });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({
      token_type: 'bearer',
      bot_id: NOTION_MOCK_IDS.bot,
      workspace_id: NOTION_MOCK_IDS.workspace,
      workspace_name: 'Oat Mock Notion',
      owner: { type: 'user' },
      duplicated_template_id: null,
    });
    expect(good.body.access_token).toMatch(/^ntn_mock_[0-9a-f]{40}$/);
    const reuse = await token(app, {
      grant_type: 'authorization_code',
      code: third,
      redirect_uri: redirect,
    });
    expect(reuse.status).toBe(400);

    // The token works until revoked.
    const access = good.body.access_token as string;
    expect((await call('GET', '/v1/users/me', { token: access })).status).toBe(200);
    const revoke = await app.request('/notion/v1/oauth/revoke', {
      method: 'POST',
      headers: { authorization: basic('oat-dev'), 'content-type': 'application/json' },
      body: JSON.stringify({ token: access }),
    });
    expect(revoke.status).toBe(200);
    const after = await call('GET', '/v1/users/me', { token: access });
    expect(after).toMatchObject({ status: 401, body: { object: 'error', code: 'unauthorized' } });
  });

  it('rejects malformed authorize requests', async () => {
    const { app } = mock();
    expect(
      (await authorize(app, 'client_id=x&response_type=token&redirect_uri=http://a/b')).status,
    ).toBe(400);
    expect((await authorize(app, 'client_id=x&response_type=code&redirect_uri=nope')).status).toBe(
      400,
    );
    expect((await authorize(app, 'response_type=code&redirect_uri=http://a/b')).status).toBe(400);
  });
});

describe('notion mock: auth and versioning', () => {
  it('needs a mock bearer token and the 2022-06-28 Notion-Version', async () => {
    const { call } = mock();
    expect((await call('GET', '/v1/users/me', { token: null })).body.code).toBe('unauthorized');
    expect((await call('GET', '/v1/users/me', { token: 'secret_real_looking' })).status).toBe(401);
    const missing = await call('GET', '/v1/users/me', { version: null });
    expect(missing).toMatchObject({ status: 400, body: { code: 'missing_version' } });
    const other = await call('GET', '/v1/users/me', { version: '2025-09-03' });
    expect(other).toMatchObject({ status: 400, body: { code: 'validation_error' } });
  });

  it('answers 429 rate_limited with Retry-After when asked to', async () => {
    const { app, call } = mock();
    await app.request('/notion/_mock/rate-limit', {
      method: 'POST',
      body: JSON.stringify({ count: 2, retryAfter: 1 }),
    });
    const first = await call('GET', '/v1/users/me');
    expect(first.status).toBe(429);
    expect(first.body.code).toBe('rate_limited');
    expect(first.headers.get('retry-after')).toBe('1');
    expect((await call('GET', '/v1/users/me')).status).toBe(429);
    expect((await call('GET', '/v1/users/me')).status).toBe(200);
  });
});

describe('notion mock: search and databases', () => {
  it('lists shared pages and databases, newest edit first, with filter/query/paging', async () => {
    const { ok } = mock();
    const all = await ok('POST', '/v1/search', {});
    expect(all).toMatchObject({ object: 'list', type: 'page_or_database', has_more: false });
    const titles = (all.results as Json[]).map((r) =>
      r.object === 'database' ? r.title[0].plain_text : r.properties.title.title[0].plain_text,
    );
    expect(titles).toEqual([
      'Scratchpad',
      'Reading list',
      'Meetings',
      'Meeting notes',
      'Team Home',
    ]);

    const dbs = await ok('POST', '/v1/search', {
      filter: { property: 'object', value: 'database' },
    });
    expect((dbs.results as Json[]).map((r) => r.id)).toEqual([
      NOTION_MOCK_IDS.readingListDb,
      NOTION_MOCK_IDS.meetingsDb,
    ]);
    const meet = await ok('POST', '/v1/search', { query: 'MEET' });
    expect((meet.results as Json[]).map((r) => r.object)).toEqual(['database', 'page']);

    const first = await ok('POST', '/v1/search', { page_size: 2 });
    expect(first.has_more).toBe(true);
    const second = await ok('POST', '/v1/search', {
      page_size: 2,
      start_cursor: first.next_cursor,
    });
    expect((second.results as Json[])[0]!.id).toBe(first.next_cursor);
  });

  it('retrieves a database schema; unknown ids are object_not_found', async () => {
    const { ok, call } = mock();
    const db = await ok('GET', `/v1/databases/${NOTION_MOCK_IDS.meetingsDb.replace(/-/g, '')}`);
    expect(db.id).toBe(NOTION_MOCK_IDS.meetingsDb);
    expect(
      Object.fromEntries(Object.entries(db.properties as Json).map(([k, v]) => [k, v.type])),
    ).toEqual({
      Name: 'title',
      Date: 'date',
      Attendees: 'rich_text',
      'Oat link': 'url',
      Tags: 'multi_select',
    });
    const missing = await call('GET', `/v1/databases/${NOTION_MOCK_IDS.teamHome}`);
    expect(missing).toMatchObject({ status: 404, body: { code: 'object_not_found' } });
    expect((await call('GET', '/v1/databases/not-a-uuid')).status).toBe(400);
  });
});

describe('notion mock: pages and blocks', () => {
  it('creates a page under a page with nested children and serves it back', async () => {
    const { createPage, ok, underNotes } = mock();
    const page = await createPage(
      underNotes({
        icon: { type: 'emoji', emoji: '🗒️' },
        children: [
          { type: 'heading_1', heading_1: { rich_text: [text('Agenda')] } },
          bullet('One', [bullet('Two', [bullet('Three')])]),
          { type: 'to_do', to_do: { rich_text: [text('Ship it')], checked: true } },
          { type: 'code', code: { rich_text: [text('let a = 1')], language: 'typescript' } },
          {
            type: 'callout',
            callout: {
              rich_text: [
                text('Heads up', { annotations: { bold: true, color: 'yellow_background' } }),
              ],
              icon: { type: 'emoji', emoji: '⚠️' },
              color: 'yellow_background',
            },
          },
          { type: 'divider', divider: {} },
          para('A link', undefined),
        ],
      }),
    );
    expect(page).toMatchObject({
      object: 'page',
      parent: { type: 'page_id', page_id: NOTION_MOCK_IDS.meetingNotes },
      archived: false,
      in_trash: false,
      properties: { title: { id: 'title', type: 'title', title: [{ plain_text: 'Weekly sync' }] } },
    });
    expect(page.url).toMatch(/\/notion\/_mock\/view\/[0-9a-f]{32}$/);
    const children = await ok('GET', `/v1/blocks/${page.id}/children`);
    expect((children.results as Json[]).map((b) => b.type)).toEqual([
      'heading_1',
      'bulleted_list_item',
      'to_do',
      'code',
      'callout',
      'divider',
      'paragraph',
    ]);
    const list = (children.results as Json[])[1]!;
    expect(list.has_children).toBe(true);
    expect((children.results as Json[])[4]!.callout.rich_text[0]).toMatchObject({
      annotations: { bold: true, italic: false, color: 'yellow_background' },
      plain_text: 'Heads up',
      href: null,
    });
    const nested = await ok('GET', `/v1/blocks/${list.id}/children`);
    expect((nested.results as Json[])[0]).toMatchObject({
      parent: { type: 'block_id', block_id: list.id },
      bulleted_list_item: { rich_text: [{ plain_text: 'Two' }] },
      has_children: true,
    });
    expect(await ok('GET', `/v1/pages/${page.id}`)).toMatchObject({ id: page.id });
  });

  it.each([
    [
      'text longer than 2000 characters',
      [para('x'.repeat(2001))],
      'body.children[0].paragraph.rich_text[0].text.content.length should be ≤ 2000, instead was 2001.',
    ],
    [
      'more than 100 children',
      Array.from({ length: 101 }, () => para('x')),
      'body.children.length should be ≤ 100, instead was 101.',
    ],
    [
      'more than 100 rich-text items',
      [
        {
          type: 'paragraph',
          paragraph: { rich_text: Array.from({ length: 101 }, () => text('a')) },
        },
      ],
      'body.children[0].paragraph.rich_text.length should be ≤ 100, instead was 101.',
    ],
    [
      'three levels of nesting',
      [bullet('1', [bullet('2', [bullet('3', [bullet('4')])])])],
      'nested at most 2 levels',
    ],
    [
      'an unknown block type',
      [{ type: 'image', image: {} }],
      'body.children[0].type should be one of',
    ],
    [
      'an unsupported code language',
      [{ type: 'code', code: { rich_text: [], language: 'klingon' } }],
      'body.children[0].code.language should be a supported language',
    ],
    [
      'a relative link',
      [
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: 'x', link: { url: '/d/1' } } }] },
        },
      ],
      'Invalid URL for link',
    ],
    [
      'a javascript: link',
      [
        {
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: 'x', link: { url: 'javascript:alert(1)' } } }],
          },
        },
      ],
      'Invalid URL for link',
    ],
    [
      'children on a heading',
      [{ type: 'heading_2', heading_2: { rich_text: [], children: [para('x')] } }],
      "heading_2 blocks can't have children",
    ],
    [
      'a bad colour',
      [{ type: 'paragraph', paragraph: { rich_text: [], color: 'teal' } }],
      'color has an invalid value',
    ],
  ])('rejects %s as validation_error', async (_name, children, message) => {
    const { call, underNotes } = mock();
    const res = await call('POST', '/v1/pages', { body: underNotes({ children }) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ object: 'error', status: 400, code: 'validation_error' });
    expect(res.body.message).toContain(message);
  });

  it('counts nested blocks toward the 1000-per-request limit', async () => {
    const { call, underNotes } = mock();
    const children = Array.from({ length: 100 }, () =>
      bullet(
        'a',
        Array.from({ length: 10 }, () => bullet('b')),
      ),
    );
    const res = await call('POST', '/v1/pages', { body: underNotes({ children }) });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at most 1000 blocks');
  });

  it('validates properties against the parent: page parents take only a title', async () => {
    const { call } = mock();
    const res = await call('POST', '/v1/pages', {
      body: {
        parent: { page_id: NOTION_MOCK_IDS.meetingNotes },
        properties: { title: { title: [text('x')] }, Date: { date: { start: '2026-11-16' } } },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid property identifier "Date"');
  });

  it('creates database rows with typed properties and rejects unknown/mistyped ones', async () => {
    const { call, createPage, app } = mock();
    const parent = { database_id: NOTION_MOCK_IDS.meetingsDb };
    const row = await createPage({
      parent,
      properties: {
        Name: { title: [text('Kickoff')] },
        Date: { date: { start: '2026-11-16T09:00:00.000Z' } },
        Attendees: { rich_text: [text('Ada, Grace')] },
        'Oat link': { url: 'http://localhost:3000/d/abc' },
      },
    });
    expect(row.parent).toEqual({ type: 'database_id', database_id: NOTION_MOCK_IDS.meetingsDb });
    expect(row.properties).toMatchObject({
      Name: { type: 'title', title: [{ plain_text: 'Kickoff' }] },
      Date: { type: 'date', date: { start: '2026-11-16T09:00:00.000Z' } },
      Attendees: { type: 'rich_text', rich_text: [{ plain_text: 'Ada, Grace' }] },
      'Oat link': { type: 'url', url: 'http://localhost:3000/d/abc' },
      Tags: { type: 'multi_select', multi_select: [] },
    });
    const unknown = await call('POST', '/v1/pages', {
      body: { parent, properties: { Owner: { rich_text: [] } } },
    });
    expect(unknown.body.message).toBe('Owner is not a property that exists.');
    const mistyped = await call('POST', '/v1/pages', {
      body: { parent, properties: { Date: { date: { start: 'tomorrow' } } } },
    });
    expect(mistyped.status).toBe(400);
    // The database view lists the row.
    const view = await app.request(`/notion/_mock/view/${NOTION_MOCK_IDS.meetingsDb}`);
    expect(await view.text()).toContain('Kickoff');
  });

  it('appends (with after), pages children, archives blocks and pages', async () => {
    const { call, ok, createPage, underNotes, app } = mock();
    const page = await createPage(underNotes({ children: [para('first'), para('last')] }));
    const [first] = (await ok('GET', `/v1/blocks/${page.id}/children`)).results as Json[];
    const appended = await ok('PATCH', `/v1/blocks/${page.id}/children`, {
      children: [para('second')],
      after: first!.id,
    });
    expect(appended).toMatchObject({ object: 'list', type: 'block' });
    await ok('PATCH', `/v1/blocks/${page.id}/children`, {
      children: Array.from({ length: 100 }, (_, i) => para(`more ${i}`)),
    });
    const p1 = await ok('GET', `/v1/blocks/${page.id}/children?page_size=2`);
    expect((p1.results as Json[]).map((b) => b.paragraph.rich_text[0].plain_text)).toEqual([
      'first',
      'second',
    ]);
    expect(p1.has_more).toBe(true);
    const p2 = await ok(
      'GET',
      `/v1/blocks/${page.id}/children?page_size=100&start_cursor=${p1.next_cursor}`,
    );
    expect((p2.results as Json[])[0]!.paragraph.rich_text[0].plain_text).toBe('last');
    expect(p2.has_more).toBe(true);

    const deleted = await ok('DELETE', `/v1/blocks/${first!.id}`);
    expect(deleted).toMatchObject({ archived: true, in_trash: true });
    expect((await call('DELETE', `/v1/blocks/${first!.id}`)).status).toBe(400);
    const tree = (await (await app.request(`/notion/_mock/pages/${page.id}/tree`)).json()) as Json;
    expect(tree.children).toHaveLength(102);
    expect(tree.children[0].paragraph.rich_text[0].plain_text).toBe('second');

    // Divider can't take children.
    const divider = await createPage(underNotes({ children: [{ type: 'divider', divider: {} }] }));
    const [div] = (await ok('GET', `/v1/blocks/${divider.id}/children`)).results as Json[];
    expect(
      (await call('PATCH', `/v1/blocks/${div!.id}/children`, { body: { children: [para('x')] } }))
        .status,
    ).toBe(400);

    // Archive the page: still retrievable (archived), but no longer editable or searchable.
    expect(await ok('PATCH', `/v1/pages/${page.id}`, { archived: true })).toMatchObject({
      in_trash: true,
    });
    expect((await ok('GET', `/v1/pages/${page.id}`)).archived).toBe(true);
    const edit = await call('PATCH', `/v1/blocks/${page.id}/children`, {
      body: { children: [para('x')] },
    });
    expect(edit).toMatchObject({ status: 400, body: { code: 'validation_error' } });
    const props = await call('PATCH', `/v1/pages/${page.id}`, {
      body: { properties: { title: { title: [] } } },
    });
    expect(props.status).toBe(400);
    const search = await ok('POST', '/v1/search', { query: 'Weekly sync' });
    expect((search.results as Json[]).map((r) => r.id)).not.toContain(page.id);
  });

  it('lists sub-pages as child_page blocks of their parent; archiving one trashes the page', async () => {
    const { ok, createPage, underNotes } = mock();
    const page = await createPage(underNotes({ children: [para('body')] }));
    const sub = await createPage({
      parent: { page_id: page.id },
      properties: { title: { title: [text('Follow-up')] } },
    });
    const children = (await ok('GET', `/v1/blocks/${page.id}/children`)).results as Json[];
    expect(children.map((b) => b.type)).toEqual(['paragraph', 'child_page']);
    expect(children[1]).toMatchObject({ id: sub.id, child_page: { title: 'Follow-up' } });
    await ok('DELETE', `/v1/blocks/${sub.id}`);
    expect((await ok('GET', `/v1/pages/${sub.id}`)).archived).toBe(true);
    expect(((await ok('GET', `/v1/blocks/${page.id}/children`)).results as Json[]).length).toBe(1);
  });

  it('updates page properties and renders the HTML view', async () => {
    const { ok, createPage, underNotes, app } = mock();
    const page = await createPage(underNotes({ children: [para('<b>not html</b>')] }));
    const updated = await ok('PATCH', `/v1/pages/${page.id}`, {
      properties: { title: { title: [text('Renamed')] } },
    });
    expect(updated.properties.title.title[0].plain_text).toBe('Renamed');
    expect(updated.last_edited_time > page.last_edited_time).toBe(true);
    const html = await (await app.request(new URL(page.url).pathname)).text();
    expect(html).toContain('Renamed');
    expect(html).toContain('&#60;b&#62;not html&#60;/b&#62;');
  });

  it('reset() restores the seed and forgets revoked tokens', async () => {
    const { app, call, createPage, underNotes } = mock();
    const page = await createPage(underNotes());
    await app.request('/notion/_mock/revoke-token', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    expect((await call('GET', '/v1/users/me')).status).toBe(401);
    await app.request('/_reset?provider=notion', { method: 'POST' });
    expect((await call('GET', '/v1/users/me')).status).toBe(200);
    expect((await call('GET', `/v1/pages/${page.id}`)).status).toBe(404);
  });

  it('logs every call (with the bearer redacted)', async () => {
    const { log, ok } = mock();
    await ok('POST', '/v1/search', { query: 'x' });
    expect(log.list({ provider: 'notion' }).at(-1)).toMatchObject({
      method: 'POST',
      path: '/notion/v1/search',
      headers: { authorization: 'Bearer [redacted]', 'notion-version': NOTION_API_VERSION },
      status: 200,
    });
  });
});
