import type { JSONContent } from '@oat/editor';
import { createApp, NOTION_MOCK_IDS, notionProvider } from '@oat/mocks';
import { describe, expect, it } from 'vitest';

import {
  exchangeNotionCode,
  NotionApiError,
  NotionAuthError,
  notionAuthorizeUrl,
  NotionClient,
  NotionOAuthError,
  revokeNotionToken,
} from './client.ts';
import { resolveNotionConfig } from './config.ts';
import { buildProperties, metaBlocks, type NoteMeta } from './properties.ts';
import { pushNote } from './push.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = 'http://notion.test/notion';
const TOKEN = 'ntn_mock_unit';

function setup() {
  const { app, log } = createApp({ providers: [() => notionProvider()] });
  const fetch = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.request(input as string, init));
  const sleeps: number[] = [];
  const client = new NotionClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const tree = async (id: string) =>
    (await (await app.request(`${BASE}/_mock/pages/${id}/tree`)).json()) as Json;
  const calls = () =>
    log
      .list({ provider: 'notion' })
      .filter((r) => r.path.includes('/v1/'))
      .map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/g, ':id')}`);
  return { app, log, fetch, client, tree, calls, sleeps };
}

const meta: NoteMeta = {
  title: 'Weekly sync',
  date: new Date('2026-11-16T17:00:00.000Z'),
  attendees: ['Ada Lovelace', 'Grace Hopper'],
  oatUrl: 'http://localhost:3000/d/doc-1',
};

const para = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const textOf = (block: Json): string =>
  ((block[block.type]?.rich_text ?? []) as Json[]).map((r) => r.plain_text).join('');

describe('pushNote: create', () => {
  it('creates a sub-page with the title, a metadata line and the content', async () => {
    const { client, tree, calls } = setup();
    let created: string | undefined;
    const result = await pushNote({
      client,
      target: { type: 'page', id: NOTION_MOCK_IDS.meetingNotes },
      doc: doc(para('Hello'), {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Next' }],
      }),
      meta,
      timeZone: 'America/Los_Angeles',
      checkpoint: (state) => void (created ??= state.page.id),
    });
    expect(result).toMatchObject({ created: true, blocks: 4 });
    expect(created).toBe(result.pageId);
    expect(result.url).toBe(`${BASE}/_mock/view/${result.pageId.replace(/-/g, '')}`);
    const page = await tree(result.pageId);
    expect(page.title).toBe('Weekly sync');
    expect(page.parent).toEqual({ type: 'page_id', page_id: NOTION_MOCK_IDS.meetingNotes });
    expect(page.children.map((b: Json) => [b.type, textOf(b)])).toEqual([
      ['paragraph', '16 Nov 2026, 09:00 · Attendees: Ada Lovelace, Grace Hopper · Open in Oat'],
      ['divider', ''],
      ['paragraph', 'Hello'],
      ['heading_2', 'Next'],
    ]);
    expect(page.children[0].paragraph.rich_text.at(-1).href).toBe(meta.oatUrl);
    expect(calls()).toEqual(['POST /notion/v1/pages', 'PATCH /notion/v1/blocks/:id/children']);
  });

  it('creates a database row with date/attendees/link properties and no metadata line', async () => {
    const { client, tree } = setup();
    const result = await pushNote({
      client,
      target: { type: 'database', id: NOTION_MOCK_IDS.meetingsDb },
      doc: doc(para('Body')),
      meta,
    });
    const page = await tree(result.pageId);
    expect(page.properties).toMatchObject({
      Name: { title: [{ plain_text: 'Weekly sync' }] },
      Date: { date: { start: '2026-11-16T17:00:00.000Z' } },
      Attendees: { rich_text: [{ plain_text: 'Ada Lovelace, Grace Hopper' }] },
      'Oat link': { url: meta.oatUrl },
    });
    expect(page.children.map((b: Json) => textOf(b))).toEqual(['Body']);
  });

  it('puts what a database has no column for into the metadata line', async () => {
    const { client, tree } = setup();
    const result = await pushNote({
      client,
      target: { type: 'database', id: NOTION_MOCK_IDS.readingListDb },
      doc: doc(para('Body')),
      meta,
    });
    const page = await tree(result.pageId);
    expect(page.properties.Title.title[0].plain_text).toBe('Weekly sync');
    expect(page.properties.Author.rich_text).toEqual([]); // not an attendees-like column
    expect(textOf(page.children[0])).toBe(
      '16 Nov 2026, 17:00 UTC · Attendees: Ada Lovelace, Grace Hopper · Open in Oat',
    );
  });

  it('sends long notes in batches of ≤ 100 blocks (first batch with the page)', async () => {
    const { client, tree, calls } = setup();
    const many = Array.from({ length: 250 }, (_, i) => para(`p${i}`));
    const result = await pushNote({
      client,
      target: { type: 'page', id: NOTION_MOCK_IDS.meetingNotes },
      doc: doc(...many),
      meta: { ...meta, date: null, attendees: [] },
    });
    expect(result.blocks).toBe(252);
    expect(calls()).toEqual([
      'POST /notion/v1/pages',
      'PATCH /notion/v1/blocks/:id/children',
      'PATCH /notion/v1/blocks/:id/children',
      'PATCH /notion/v1/blocks/:id/children',
    ]);
    expect(result.blockIds).toHaveLength(252);
    const page = await tree(result.pageId);
    expect(page.children).toHaveLength(252);
    expect(textOf(page.children.at(-1))).toBe('p249');
  });
});

describe('pushNote: update', () => {
  it('replaces the content and updates properties of the same page', async () => {
    const { client, tree, log } = setup();
    const target = { type: 'database', id: NOTION_MOCK_IDS.meetingsDb } as const;
    const first = await pushNote({ client, target, doc: doc(para('v1 a'), para('v1 b')), meta });
    const since = log.list({ provider: 'notion' }).length;
    const second = await pushNote({
      client,
      target,
      existingPageId: first.pageId,
      doc: doc(para('v2')),
      meta: { ...meta, title: 'Weekly sync (edited)', attendees: ['Ada Lovelace'] },
    });
    expect(second).toMatchObject({ pageId: first.pageId, created: false, url: first.url });
    const page = await tree(first.pageId);
    expect(page.properties.Name.title[0].plain_text).toBe('Weekly sync (edited)');
    expect(page.properties.Attendees.rich_text[0].plain_text).toBe('Ada Lovelace');
    expect(page.children.map(textOf)).toEqual(['v2']);
    const updateCalls = log
      .list({ provider: 'notion' })
      .slice(since)
      .filter((r) => r.path.includes('/v1/'))
      .map((r) => `${r.method} ${r.path.replace(/[0-9a-f-]{36}/g, ':id')}`);
    expect(updateCalls).toEqual([
      'GET /notion/v1/pages/:id',
      'GET /notion/v1/databases/:id',
      'GET /notion/v1/blocks/:id/children',
      'PATCH /notion/v1/pages/:id',
      'PATCH /notion/v1/blocks/:id/children',
      'DELETE /notion/v1/blocks/:id',
      'DELETE /notion/v1/blocks/:id',
    ]);
  });

  it('only archives blocks Oat wrote: the user’s sub-pages and own blocks survive a re-push', async () => {
    const { client, tree } = setup();
    const target = { type: 'page', id: NOTION_MOCK_IDS.meetingNotes } as const;
    const first = await pushNote({ client, target, doc: doc(para('v1')), meta });
    expect(first.blockIds).toHaveLength(3); // metadata line, divider, v1
    // In Notion, the user adds a follow-up sub-page and a paragraph of their own under the note.
    const sub = await client.createPage({
      parent: { page_id: first.pageId },
      properties: { title: { title: [{ type: 'text', text: { content: 'Follow-up' } }] } },
    });
    await client.appendChildren(first.pageId, [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'mine' } }] },
      },
    ]);
    const second = await pushNote({
      client,
      target,
      existingPageId: first.pageId,
      ownedBlockIds: first.blockIds,
      doc: doc(para('v2')),
      meta,
    });
    const page = await tree(first.pageId);
    expect(
      page.children.map((b: Json) => (b.type === 'child_page' ? 'child_page' : textOf(b))),
    ).toEqual(['child_page', 'mine', expect.stringContaining('Open in Oat'), '', 'v2']);
    expect((await client.retrievePage(sub.id)).archived).toBe(false);
    expect(second.blockIds).toHaveLength(3);

    // Unknown ownership (rows from before tracking): still never archives sub-pages.
    await pushNote({ client, target, existingPageId: first.pageId, doc: doc(para('v3')), meta });
    const again = await tree(first.pageId);
    expect(again.children.map((b: Json) => b.type)).toEqual([
      'child_page',
      'paragraph',
      'divider',
      'paragraph',
    ]);
    expect((await client.retrievePage(sub.id)).archived).toBe(false);
  });

  it('stops when a checkpoint throws and takes back the batch it just wrote', async () => {
    const { client, tree } = setup();
    const target = { type: 'page', id: NOTION_MOCK_IDS.meetingNotes } as const;
    const first = await pushNote({ client, target, doc: doc(para('kept')), meta });
    let calls = 0;
    const lost = new Error('lease lost');
    const error = await pushNote({
      client,
      target,
      existingPageId: first.pageId,
      ownedBlockIds: first.blockIds,
      doc: doc(para('never')),
      meta,
      // before update, before append, after append → throw
      checkpoint: () => {
        if (++calls === 3) throw lost;
      },
    }).catch((e: unknown) => e);
    expect(error).toBe(lost);
    const page = await tree(first.pageId);
    expect(page.children.map(textOf).at(-1)).toBe('kept');
    expect(page.children.map(textOf)).not.toContain('never');
  });

  it('creates a new page when the old one was archived or deleted in Notion', async () => {
    const { client, tree } = setup();
    const target = { type: 'page', id: NOTION_MOCK_IDS.meetingNotes } as const;
    const first = await pushNote({ client, target, doc: doc(para('one')), meta });
    await client.updatePage(first.pageId, { archived: true });
    const second = await pushNote({
      client,
      target,
      existingPageId: first.pageId,
      doc: doc(para('two')),
      meta,
    });
    expect(second.created).toBe(true);
    expect(second.pageId).not.toBe(first.pageId);
    expect((await tree(second.pageId)).children.map(textOf).at(-1)).toBe('two');

    const third = await pushNote({
      client,
      target,
      existingPageId: '00000000-0000-4000-8000-000000000000',
      doc: doc(para('three')),
      meta,
    });
    expect(third.created).toBe(true);
  });

  it('retries 429s using Retry-After', async () => {
    const { app, client, sleeps } = setup();
    await app.request(`${BASE}/_mock/rate-limit`, {
      method: 'POST',
      body: JSON.stringify({ count: 2, retryAfter: 2 }),
    });
    const result = await pushNote({
      client,
      target: { type: 'page', id: NOTION_MOCK_IDS.meetingNotes },
      doc: doc(para('x')),
      meta,
    });
    expect(result.created).toBe(true);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('surfaces a revoked token as NotionAuthError and validation errors as NotionApiError', async () => {
    const { app, client } = setup();
    await app.request(`${BASE}/_mock/revoke-token`, {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
    await expect(
      pushNote({
        client,
        target: { type: 'page', id: NOTION_MOCK_IDS.meetingNotes },
        doc: doc(para('x')),
        meta,
      }),
    ).rejects.toBeInstanceOf(NotionAuthError);

    const fresh = setup();
    const error = await pushNote({
      client: fresh.client,
      target: { type: 'database', id: NOTION_MOCK_IDS.teamHome },
      doc: doc(para('x')),
      meta,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionApiError);
    expect((error as NotionApiError).isNotFound()).toBe(true);
  });
});

describe('properties', () => {
  it('page parents only get a title; blank titles become Untitled', () => {
    expect(buildProperties({ ...meta, title: '  ' })).toEqual({
      properties: { title: { title: [{ type: 'text', text: { content: 'Untitled' } }] } },
      covered: { date: false, attendees: false, link: false },
    });
  });

  it('metaBlocks is empty when every field is a property, and skips missing values', () => {
    expect(metaBlocks(meta, { date: true, attendees: true, link: true })).toEqual([]);
    const blocks = metaBlocks(
      { ...meta, date: null, attendees: [] },
      { date: false, attendees: false, link: false },
    );
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'divider']);
    expect(blocks[0]!.paragraph!.rich_text!.map((r) => r.text.content)).toEqual(['Open in Oat']);
    // An unknown zone falls back to UTC.
    const utc = metaBlocks(
      meta,
      { date: false, attendees: true, link: true },
      { timeZone: 'Mars/Base' },
    );
    expect(utc[0]!.paragraph!.rich_text![0]!.text.content).toBe('16 Nov 2026, 17:00 UTC');
  });
});

describe('OAuth helpers', () => {
  it('builds the authorize URL, exchanges the code and revokes the token', async () => {
    const { app, fetch, client } = setup();
    const config = { baseUrl: BASE, clientId: 'oat-dev', clientSecret: 'shh', fetch };
    const url = notionAuthorizeUrl(config, {
      redirectUri: 'http://localhost:3000/cb',
      state: 'st',
    });
    expect(url).toBe(
      `${BASE}/v1/oauth/authorize?client_id=oat-dev&response_type=code&owner=user&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb&state=st`,
    );
    const redirect = await app.request(url);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const token = await exchangeNotionCode(config, {
      code,
      redirectUri: 'http://localhost:3000/cb',
    });
    expect(token).toMatchObject({ bot_id: NOTION_MOCK_IDS.bot, workspace_name: 'Oat Mock Notion' });

    const again = await exchangeNotionCode(config, {
      code,
      redirectUri: 'http://localhost:3000/cb',
    }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(NotionOAuthError);
    expect((again as NotionOAuthError).code).toBe('invalid_grant');

    const withToken = new NotionClient({ baseUrl: BASE, token: token.access_token, fetch });
    expect((await withToken.search({})).results.length).toBeGreaterThan(0);
    expect(await revokeNotionToken(config, token.access_token)).toBe(true);
    await expect(withToken.search({})).rejects.toBeInstanceOf(NotionAuthError);
    // Unreachable server: false, no throw.
    expect(
      await revokeNotionToken({ ...config, fetch: () => Promise.reject(new Error('down')) }, 'x'),
    ).toBe(false);
    expect(client.requests).toBe(0);
  });
});

describe('resolveNotionConfig', () => {
  it('prefers NOTION_BASE_URL, then real Notion with a client id, then the mocks service', () => {
    expect(resolveNotionConfig({ NOTION_BASE_URL: 'http://x/notion/' })).toEqual({
      baseUrl: 'http://x/notion',
      clientId: 'oat-dev',
      clientSecret: 'oat-dev-secret',
      mode: 'mock',
    });
    expect(
      resolveNotionConfig({ NOTION_OAUTH_CLIENT_ID: 'id', NOTION_OAUTH_CLIENT_SECRET: 's' }),
    ).toEqual({
      baseUrl: 'https://api.notion.com',
      clientId: 'id',
      clientSecret: 's',
      mode: 'real',
    });
    expect(resolveNotionConfig({ MOCKS_URL: 'http://localhost:14010' })?.baseUrl).toBe(
      'http://localhost:14010/notion',
    );
    expect(resolveNotionConfig({})?.baseUrl).toBe('http://localhost:14010/notion');
  });

  it('is unconfigured in production without anything set, or real Notion without a secret', () => {
    expect(resolveNotionConfig({ NODE_ENV: 'production' })).toBeNull();
    expect(resolveNotionConfig({ NOTION_OAUTH_CLIENT_ID: 'id' })).toBeNull();
    expect(resolveNotionConfig({ NOTION_BASE_URL: 'https://api.notion.com' })).toBeNull();
  });
});
