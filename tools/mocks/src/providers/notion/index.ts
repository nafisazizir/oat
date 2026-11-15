import { randomBytes, randomUUID } from 'node:crypto';

import { type Context, Hono } from 'hono';

import type { MockProvider } from '../../provider.ts';
import {
  type BlockRec,
  createStore,
  type DatabaseRec,
  fullRichText,
  type Json,
  normalizeId,
  NOTION_MOCK_IDS,
  NOTION_MOCK_WORKSPACE,
  type NotionObject,
  type PageRec,
  type Parent,
  type RichText,
  type Store,
  titleOf,
} from './store.ts';
import {
  blockType,
  countBlocks,
  LIMITS,
  validateChildren,
  validateIcon,
  validatePropertyValue,
  ValidationError,
} from './validate.ts';
import { renderPageHtml } from './view.ts';

/**
 * Notion public API subset (stands in for `https://api.notion.com`), served at `/notion/v1/…`, version
 * `2022-06-28` (the `Notion-Version` header is required; other versions get a 400). Clients use
 * `NOTION_BASE_URL=${MOCKS_URL}/notion`.
 *
 * OAuth (public integration):
 * - `GET  /v1/oauth/authorize?client_id&redirect_uri&response_type=code&owner=user&state` auto-approves (dev):
 *   302 to `redirect_uri?code=…&state=…`. The code is single-use and lives 10 minutes.
 * - `POST /v1/oauth/token` (HTTP Basic `client_id:client_secret`, JSON `{ grant_type: 'authorization_code',
 *   code, redirect_uri }`) → `{ access_token, token_type, bot_id, workspace_id, workspace_name,
 *   workspace_icon, owner, duplicated_template_id }`. OAuth-style errors (`invalid_grant`, `invalid_client`).
 * - `POST /v1/oauth/revoke` (Basic, `{ token }`): that token gets 401 from now on.
 *
 * API (`Authorization: Bearer <token>`; any `ntn_mock_…` token is accepted unless revoked, so stored dev
 * tokens survive a container restart; anything else is 401 `unauthorized`):
 * - `POST /v1/search` (`query`, `filter: { property: 'object', value: 'page'|'database' }`, `sort`,
 *   `start_cursor`, `page_size` ≤ 100).
 * - `GET /v1/databases/{id}` (properties schema), `GET /v1/pages/{id}`, `GET /v1/users/me`.
 * - `POST /v1/pages` (`parent: { page_id } | { database_id }`, `properties`, `icon`, `children` ≤ 100):
 *   page parents take only `title`; database parents take properties by name or id, typed per schema.
 * - `PATCH /v1/pages/{id}` (`properties`, `icon`, `archived`/`in_trash`).
 * - `GET /v1/blocks/{id}`, `GET /v1/blocks/{id}/children` (`start_cursor`, `page_size` ≤ 100),
 *   `PATCH /v1/blocks/{id}/children` (`children` ≤ 100, `after`), `DELETE /v1/blocks/{id}` (archives; a page
 *   id archives the page).
 * Payloads are validated like Notion does (`./validate.ts`): block types and shapes, 2000 characters per
 * rich-text item, 100 items per rich-text array, 100 blocks per children array, two levels of nesting,
 * 1000 blocks / 500 KB per request. Errors: `{ object: 'error', status, code, message }`.
 *
 * Page `url`s point at `/notion/_mock/view/{id}` on this server (a plain HTML rendering), so "Open in
 * Notion" works offline.
 *
 * Test controls: `POST /_mock/revoke-token { token }`, `POST /_mock/rate-limit { count, retryAfter? }` (the
 * next `count` API calls get 429 `rate_limited` with `Retry-After`), `GET /_mock/pages/{id}/tree` (the page
 * with its live block tree), `GET /_mock/view/{id}` (HTML).
 */
export interface NotionProviderOptions {
  now?: () => number;
}

export const NOTION_API_VERSION = '2022-06-28';
export const NOTION_MOCK_TOKEN_PREFIX = 'ntn_mock_';
export { NOTION_MOCK_IDS, NOTION_MOCK_WORKSPACE };

const CODE_TTL_MS = 10 * 60_000;

type ErrorCode =
  | 'invalid_json'
  | 'invalid_request_url'
  | 'invalid_request'
  | 'validation_error'
  | 'missing_version'
  | 'unauthorized'
  | 'restricted_resource'
  | 'object_not_found'
  | 'conflict_error'
  | 'rate_limited';

function notionError(c: Context, status: number, code: ErrorCode, message: string) {
  return c.json(
    { object: 'error', status, code, message, request_id: randomUUID() },
    status as 400,
  );
}

class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function basicClientId(header: string | undefined): string | undefined {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0 || colon === decoded.length - 1) return undefined;
  return decoded.slice(0, colon);
}

export function notionProvider(options: NotionProviderOptions = {}): MockProvider {
  const now = options.now ?? Date.now;
  let store: Store = createStore(now);
  const codes = new Map<string, { clientId: string; redirectUri: string; expiresAt: number }>();
  const revoked = new Set<string>();
  let throttle = { count: 0, retryAfter: 0 };

  const app = new Hono();

  const origin = (c: Context) => new URL(c.req.url).origin;
  const viewUrl = (c: Context, id: string) =>
    `${origin(c)}/notion/_mock/view/${id.replace(/-/g, '')}`;
  const actor = { object: 'user', id: NOTION_MOCK_IDS.bot };

  // ---------------------------------------------------------------------------------------------------
  // Serialisation

  function pageJson(c: Context, p: PageRec): Json {
    return {
      object: 'page',
      id: p.id,
      created_time: p.created,
      last_edited_time: p.edited,
      created_by: actor,
      last_edited_by: actor,
      cover: null,
      icon: p.icon,
      parent: p.parent,
      archived: p.archived,
      in_trash: p.archived,
      properties: p.properties,
      url: viewUrl(c, p.id),
      public_url: null,
    };
  }

  function databaseJson(c: Context, d: DatabaseRec): Json {
    return {
      object: 'database',
      id: d.id,
      created_time: d.created,
      last_edited_time: d.edited,
      created_by: actor,
      last_edited_by: actor,
      title: d.title,
      description: [],
      icon: d.icon,
      cover: null,
      properties: d.properties,
      parent: d.parent,
      url: viewUrl(c, d.id),
      archived: d.archived,
      in_trash: d.archived,
      is_inline: false,
      public_url: null,
    };
  }

  /** Live children of a page/block: blocks, and sub-pages (which Notion lists as `child_page` blocks). */
  const liveChildren = (ids: readonly string[]) =>
    ids
      .map((id) => store.objects.get(id))
      .filter((o): o is BlockRec | PageRec => !!o && o.kind !== 'database' && !o.archived);

  function blockJson(b: BlockRec | PageRec): Json {
    if (b.kind === 'page') {
      return {
        object: 'block',
        id: b.id,
        parent: b.parent,
        created_time: b.created,
        last_edited_time: b.edited,
        created_by: actor,
        last_edited_by: actor,
        has_children: liveChildren(b.children).length > 0,
        archived: b.archived,
        in_trash: b.archived,
        type: 'child_page',
        child_page: { title: titleOf(b) },
      };
    }
    return {
      object: 'block',
      id: b.id,
      parent: b.parent,
      created_time: b.created,
      last_edited_time: b.edited,
      created_by: actor,
      last_edited_by: actor,
      has_children: liveChildren(b.children).length > 0,
      archived: b.archived,
      in_trash: b.archived,
      type: b.type,
      [b.type]: b.data,
    };
  }

  function tree(id: string): Json[] {
    const obj = store.objects.get(id);
    const ids = obj && obj.kind !== 'database' ? obj.children : [];
    return liveChildren(ids).map((b) => ({ ...blockJson(b), children: tree(b.id) }));
  }

  // ---------------------------------------------------------------------------------------------------
  // Lookups

  function idParam(c: Context): string {
    const raw = c.req.param('id') ?? '';
    const id = normalizeId(raw);
    if (!id)
      throw new HttpError(
        400,
        'validation_error',
        `path.id should be a valid uuid, instead was "${raw}".`,
      );
    return id;
  }

  function find<K extends NotionObject['kind']>(
    id: string,
    kind: K,
  ): Extract<NotionObject, { kind: K }> {
    const obj = store.objects.get(id);
    if (!obj || obj.kind !== kind) {
      const what = kind === 'block' ? 'block' : kind;
      throw new HttpError(
        404,
        'object_not_found',
        `Could not find ${what} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
      );
    }
    return obj as Extract<NotionObject, { kind: K }>;
  }

  /** A page or block that can take children. */
  function container(id: string): PageRec | BlockRec {
    const obj = store.objects.get(id);
    if (!obj || obj.kind === 'database') {
      throw new HttpError(
        404,
        'object_not_found',
        `Could not find block with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
      );
    }
    return obj;
  }

  const archivedError = () =>
    new HttpError(
      400,
      'validation_error',
      "Can't edit block that is archived. You must unarchive the block before editing.",
    );

  async function body(c: Context): Promise<Record<string, unknown>> {
    const raw = await c.req.text();
    if (raw.length > LIMITS.bodyBytes) {
      throw new HttpError(
        400,
        'validation_error',
        `Request body too large (limit ${LIMITS.bodyBytes} bytes).`,
      );
    }
    if (raw.trim() === '') return {};
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Error parsing JSON body.');
    }
    if (!isObject(json)) throw new HttpError(400, 'validation_error', 'body should be an object.');
    return json;
  }

  // ---------------------------------------------------------------------------------------------------
  // Writes

  function insertBlocks(children: readonly unknown[], parent: Parent): string[] {
    return children.map((raw) => {
      const block = raw as Record<string, unknown>;
      const type = blockType(block)!;
      const { children: nested, ...rest } = block[type] as Json;
      const data: Json = { ...rest };
      if ('rich_text' in data) data.rich_text = fullRichText(data.rich_text as unknown[]);
      if (type !== 'divider' && type !== 'code' && data.color === undefined) data.color = 'default';
      if (type === 'to_do') data.checked = data.checked ?? false;
      if (type === 'code') data.caption = fullRichText((data.caption as unknown[]) ?? []);
      if (type === 'callout') data.icon = data.icon ?? { type: 'emoji', emoji: '💡' };
      if (type.startsWith('heading_')) data.is_toggleable = data.is_toggleable ?? false;
      const t = store.stamp();
      const id = randomUUID();
      const rec: BlockRec = {
        kind: 'block',
        id,
        parent,
        type,
        data,
        archived: false,
        created: t,
        edited: t,
        children: [],
      };
      store.objects.set(id, rec);
      if (Array.isArray(nested))
        rec.children = insertBlocks(nested, { type: 'block_id', block_id: id });
      return id;
    });
  }

  function validateRequestChildren(children: unknown): void {
    validateChildren(children, 'body.children');
    const total = countBlocks(children as unknown[]);
    if (total > LIMITS.blocksPerRequest) {
      throw new ValidationError(
        `body.children: a request can contain at most ${LIMITS.blocksPerRequest} blocks, instead was ${total}.`,
      );
    }
  }

  /** Property values for a page in `parent`, validated; `existing` for updates (merged). */
  function pageProperties(
    parent: Parent,
    input: unknown,
    existing?: Record<string, Json>,
  ): Record<string, Json> {
    if (input !== undefined && !isObject(input)) {
      throw new ValidationError('body.properties should be an object.');
    }
    const given = (input ?? {}) as Record<string, unknown>;
    if (parent.type !== 'database_id') {
      for (const key of Object.keys(given)) {
        if (key !== 'title') {
          throw new ValidationError(
            `Invalid property identifier "${key}": pages whose parent is a page can only have a "title" property.`,
          );
        }
      }
      const out = { ...(existing ?? { title: { id: 'title', type: 'title', title: [] } }) };
      if (given.title !== undefined) {
        validatePropertyValue('title', given.title, 'body.properties.title');
        out.title = {
          id: 'title',
          type: 'title',
          title: fullRichText((given.title as { title: unknown[] }).title),
        };
      }
      return out;
    }
    const db = find(parent.database_id, 'database');
    const out: Record<string, Json> = existing
      ? { ...existing }
      : Object.fromEntries(
          Object.values(db.properties).map((p) => [
            p.name,
            { id: p.id, type: p.type, [p.type]: emptyValue(p.type) },
          ]),
        );
    for (const [key, value] of Object.entries(given)) {
      const schema = Object.values(db.properties).find((p) => p.name === key || p.id === key);
      if (!schema) throw new ValidationError(`${key} is not a property that exists.`);
      validatePropertyValue(schema.type, value, `body.properties.${key}`);
      let v = (value as Record<string, unknown>)[schema.type];
      if (schema.type === 'title' || schema.type === 'rich_text') v = fullRichText(v as unknown[]);
      out[schema.name] = { id: schema.id, type: schema.type, [schema.type]: v };
    }
    return out;
  }

  function touch(obj: PageRec | BlockRec) {
    obj.edited = store.stamp();
  }

  // ---------------------------------------------------------------------------------------------------
  // Test controls (not Notion)

  app.post('/_mock/revoke-token', async (c) => {
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof token !== 'string' || !token) return c.json({ error: 'token required' }, 400);
    revoked.add(token);
    return c.json({ ok: true });
  });

  app.post('/_mock/rate-limit', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as {
      count?: unknown;
      retryAfter?: unknown;
    };
    const count = Number(input.count ?? 1);
    const retryAfter = Number(input.retryAfter ?? 0);
    if (!Number.isInteger(count) || count < 0 || !Number.isFinite(retryAfter) || retryAfter < 0) {
      return c.json({ error: 'count and retryAfter must be non-negative' }, 400);
    }
    throttle = { count, retryAfter };
    return c.json({ ok: true, ...throttle });
  });

  app.get('/_mock/pages/:id/tree', (c) => {
    const id = normalizeId(c.req.param('id'));
    const obj = id ? store.objects.get(id) : undefined;
    if (!obj || obj.kind !== 'page') return c.json({ error: 'not_found' }, 404);
    return c.json({ ...pageJson(c, obj), title: titleOf(obj), children: tree(obj.id) });
  });

  app.get('/_mock/view/:id', (c) => {
    const id = normalizeId(c.req.param('id'));
    const obj = id ? store.objects.get(id) : undefined;
    if (!obj || obj.kind === 'block') return c.html('<h1>Not found</h1>', 404);
    if (obj.kind === 'database') {
      const rows = [...store.objects.values()].filter(
        (o): o is PageRec =>
          o.kind === 'page' &&
          o.parent.type === 'database_id' &&
          o.parent.database_id === obj.id &&
          !o.archived,
      );
      return c.html(
        renderPageHtml({
          title: titleOf(obj),
          icon: obj.icon,
          archived: obj.archived,
          properties: {},
          blocks: [],
          rows: rows.map((r) => ({ title: titleOf(r), url: viewUrl(c, r.id) })),
        }),
      );
    }
    return c.html(
      renderPageHtml({
        title: titleOf(obj),
        icon: obj.icon,
        archived: obj.archived,
        properties: obj.parent.type === 'database_id' ? obj.properties : {},
        blocks: tree(obj.id),
      }),
    );
  });

  // ---------------------------------------------------------------------------------------------------
  // OAuth

  app.get('/v1/oauth/authorize', (c) => {
    const q = c.req.query();
    const problems: string[] = [];
    if (!q.client_id) problems.push('client_id is required');
    if (q.response_type !== 'code') problems.push('response_type must be "code"');
    if (q.owner !== undefined && q.owner !== 'user') problems.push('owner must be "user"');
    let redirect: URL | undefined;
    try {
      redirect = new URL(q.redirect_uri ?? '');
      if (!['http:', 'https:'].includes(redirect.protocol)) redirect = undefined;
    } catch {
      redirect = undefined;
    }
    if (!redirect) problems.push('redirect_uri must be an absolute http(s) URL');
    if (problems.length > 0 || !redirect) {
      return c.json({ error: 'invalid_request', error_description: problems.join('; ') }, 400);
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      clientId: q.client_id!,
      redirectUri: q.redirect_uri!,
      expiresAt: now() + CODE_TTL_MS,
    });
    redirect.searchParams.set('code', code);
    if (q.state !== undefined) redirect.searchParams.set('state', q.state);
    return c.redirect(redirect.toString(), 302);
  });

  app.post('/v1/oauth/token', async (c) => {
    const clientId = basicClientId(c.req.header('authorization'));
    if (!clientId) {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Missing or malformed HTTP Basic client credentials.',
        },
        401,
      );
    }
    const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (input.grant_type !== 'authorization_code') {
      return c.json(
        {
          error: 'unsupported_grant_type',
          error_description: 'grant_type must be authorization_code.',
        },
        400,
      );
    }
    const code = typeof input.code === 'string' ? codes.get(input.code) : undefined;
    if (code) codes.delete(input.code as string);
    if (!code || code.expiresAt < now() || code.clientId !== clientId) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid code.' }, 400);
    }
    if (input.redirect_uri !== code.redirectUri) {
      return c.json({ error: 'invalid_grant', error_description: 'Invalid redirect_uri.' }, 400);
    }
    return c.json({
      access_token: `${NOTION_MOCK_TOKEN_PREFIX}${randomBytes(20).toString('hex')}`,
      token_type: 'bearer',
      bot_id: NOTION_MOCK_IDS.bot,
      workspace_id: NOTION_MOCK_WORKSPACE.id,
      workspace_name: NOTION_MOCK_WORKSPACE.name,
      workspace_icon: NOTION_MOCK_WORKSPACE.icon,
      owner: {
        type: 'user',
        user: {
          object: 'user',
          id: NOTION_MOCK_IDS.owner,
          name: 'Mock Notion User',
          avatar_url: null,
          type: 'person',
          person: { email: 'notion-user@example.test' },
        },
      },
      duplicated_template_id: null,
      request_id: randomUUID(),
    });
  });

  app.post('/v1/oauth/revoke', async (c) => {
    if (!basicClientId(c.req.header('authorization'))) {
      return c.json(
        { error: 'invalid_client', error_description: 'Missing HTTP Basic client credentials.' },
        401,
      );
    }
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof token !== 'string' || !token) {
      return c.json({ error: 'invalid_request', error_description: 'token is required.' }, 400);
    }
    revoked.add(token);
    return c.json({});
  });

  // ---------------------------------------------------------------------------------------------------
  // API: auth, version, rate limit

  app.use('/v1/*', async (c, next) => {
    if (c.req.path.includes('/v1/oauth/')) return next();
    const auth = c.req.header('authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!token.startsWith(NOTION_MOCK_TOKEN_PREFIX) || revoked.has(token)) {
      return notionError(c, 401, 'unauthorized', 'API token is invalid.');
    }
    const version = c.req.header('notion-version');
    if (!version) {
      return notionError(
        c,
        400,
        'missing_version',
        'Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.',
      );
    }
    if (version !== NOTION_API_VERSION) {
      return notionError(
        c,
        400,
        'validation_error',
        `This mock implements Notion-Version ${NOTION_API_VERSION}, not ${version}.`,
      );
    }
    if (throttle.count > 0) {
      throttle.count -= 1;
      c.header('Retry-After', String(throttle.retryAfter));
      return notionError(
        c,
        429,
        'rate_limited',
        'You have been rate limited. Please try again in a few minutes.',
      );
    }
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return notionError(c, err.status, err.code, err.message);
    if (err instanceof ValidationError) return notionError(c, 400, 'validation_error', err.message);
    throw err;
  });

  app.get('/v1/users/me', (c) =>
    c.json({
      object: 'user',
      id: NOTION_MOCK_IDS.bot,
      name: 'Oat',
      avatar_url: null,
      type: 'bot',
      bot: {
        owner: { type: 'workspace', workspace: true },
        workspace_name: NOTION_MOCK_WORKSPACE.name,
      },
    }),
  );

  app.post('/v1/search', async (c) => {
    const input = await body(c);
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    let only: 'page' | 'database' | undefined;
    if (input.filter !== undefined) {
      const f = input.filter as Record<string, unknown>;
      if (
        !isObject(f) ||
        f.property !== 'object' ||
        (f.value !== 'page' && f.value !== 'database')
      ) {
        throw new ValidationError(
          'body.filter should be { property: "object", value: "page" | "database" }.',
        );
      }
      only = f.value;
    }
    const sort = input.sort as { direction?: string; timestamp?: string } | undefined;
    if (
      sort !== undefined &&
      (!isObject(sort) ||
        sort.timestamp !== 'last_edited_time' ||
        !['ascending', 'descending'].includes(String(sort.direction)))
    ) {
      throw new ValidationError(
        'body.sort should be { timestamp: "last_edited_time", direction }.',
      );
    }
    const pageSize = input.page_size === undefined ? LIMITS.pageSize : Number(input.page_size);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.pageSize) {
      throw new ValidationError(`body.page_size should be between 1 and ${LIMITS.pageSize}.`);
    }
    const matches = [...store.objects.values()]
      .filter((o): o is PageRec | DatabaseRec => o.kind !== 'block' && !o.archived)
      .filter((o) => !only || o.kind === only)
      .filter((o) => !query || titleOf(o).toLowerCase().includes(query))
      .sort(
        (a, b) => (sort?.direction === 'ascending' ? 1 : -1) * a.edited.localeCompare(b.edited),
      );
    let start = 0;
    if (input.start_cursor !== undefined) {
      start = matches.findIndex((o) => o.id === input.start_cursor);
      if (start < 0) throw new ValidationError('body.start_cursor is not a valid cursor.');
    }
    const results = matches.slice(start, start + pageSize);
    const next = matches[start + pageSize];
    return c.json({
      object: 'list',
      results: results.map((o) => (o.kind === 'page' ? pageJson(c, o) : databaseJson(c, o))),
      next_cursor: next?.id ?? null,
      has_more: next !== undefined,
      type: 'page_or_database',
      page_or_database: {},
    });
  });

  app.get('/v1/databases/:id', (c) => c.json(databaseJson(c, find(idParam(c), 'database'))));

  app.get('/v1/pages/:id', (c) => c.json(pageJson(c, find(idParam(c), 'page'))));

  app.post('/v1/pages', async (c) => {
    const input = await body(c);
    const rawParent = input.parent as Record<string, unknown> | undefined;
    let parent: Parent;
    if (isObject(rawParent) && typeof rawParent.page_id === 'string') {
      const id = normalizeId(rawParent.page_id);
      if (!id) throw new ValidationError('body.parent.page_id should be a valid uuid.');
      const p = find(id, 'page');
      if (p.archived) throw archivedError();
      parent = { type: 'page_id', page_id: id };
    } else if (isObject(rawParent) && typeof rawParent.database_id === 'string') {
      const id = normalizeId(rawParent.database_id);
      if (!id) throw new ValidationError('body.parent.database_id should be a valid uuid.');
      const d = find(id, 'database');
      if (d.archived) throw archivedError();
      parent = { type: 'database_id', database_id: id };
    } else {
      throw new ValidationError(
        'body.parent should be { page_id } or { database_id }, instead was undefined.',
      );
    }
    const properties = pageProperties(parent, input.properties);
    if (input.icon !== undefined && input.icon !== null) validateIcon(input.icon, 'body.icon');
    if (input.children !== undefined) validateRequestChildren(input.children);
    const t = store.stamp();
    const page: PageRec = {
      kind: 'page',
      id: randomUUID(),
      parent,
      properties,
      icon: (input.icon as Json | undefined) ?? null,
      archived: false,
      created: t,
      edited: t,
      children: [],
    };
    store.objects.set(page.id, page);
    // A sub-page is also a `child_page` block of its parent page.
    if (parent.type === 'page_id')
      (store.objects.get(parent.page_id) as PageRec).children.push(page.id);
    if (Array.isArray(input.children)) {
      page.children = insertBlocks(input.children, { type: 'page_id', page_id: page.id });
    }
    return c.json(pageJson(c, page));
  });

  app.patch('/v1/pages/:id', async (c) => {
    const page = find(idParam(c), 'page');
    const input = await body(c);
    const unarchive = input.archived === false || input.in_trash === false;
    const archive = input.archived === true || input.in_trash === true;
    if (page.archived && !unarchive) throw archivedError();
    const properties =
      input.properties === undefined
        ? page.properties
        : pageProperties(page.parent, input.properties, page.properties);
    if (input.icon !== undefined && input.icon !== null) validateIcon(input.icon, 'body.icon');
    page.properties = properties;
    if (input.icon !== undefined) page.icon = (input.icon as Json | null) ?? null;
    if (archive) page.archived = true;
    if (unarchive) page.archived = false;
    touch(page);
    return c.json(pageJson(c, page));
  });

  app.get('/v1/blocks/:id', (c) => c.json(blockJson(find(idParam(c), 'block'))));

  app.get('/v1/blocks/:id/children', (c) => {
    const parent = container(idParam(c));
    const q = c.req.query();
    const pageSize = q.page_size === undefined ? LIMITS.pageSize : Number(q.page_size);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.pageSize) {
      throw new ValidationError(`query.page_size should be between 1 and ${LIMITS.pageSize}.`);
    }
    const live = liveChildren(parent.children);
    let start = 0;
    if (q.start_cursor !== undefined) {
      start = live.findIndex((b) => b.id === normalizeId(q.start_cursor!));
      if (start < 0) throw new ValidationError('query.start_cursor is not a valid cursor.');
    }
    const next = live[start + pageSize];
    return c.json({
      object: 'list',
      results: live.slice(start, start + pageSize).map(blockJson),
      next_cursor: next?.id ?? null,
      has_more: next !== undefined,
      type: 'block',
      block: {},
    });
  });

  app.patch('/v1/blocks/:id/children', async (c) => {
    const parent = container(idParam(c));
    if (parent.archived) throw archivedError();
    if (parent.kind === 'block') {
      const canHaveChildren =
        [
          'paragraph',
          'bulleted_list_item',
          'numbered_list_item',
          'to_do',
          'toggle',
          'quote',
          'callout',
        ].includes(parent.type) ||
        (parent.type.startsWith('heading_') && parent.data.is_toggleable === true);
      if (!canHaveChildren) {
        throw new ValidationError(`Block type ${parent.type} does not support children.`);
      }
    }
    const input = await body(c);
    if (input.children === undefined)
      throw new ValidationError('body.children should be defined, instead was undefined.');
    validateRequestChildren(input.children);
    let at = parent.children.length;
    if (input.after !== undefined) {
      const after = typeof input.after === 'string' ? normalizeId(input.after) : undefined;
      const index = after ? parent.children.indexOf(after) : -1;
      if (index < 0)
        throw new ValidationError('body.after should be the id of a child of this block.');
      at = index + 1;
    }
    const ref: Parent =
      parent.kind === 'page'
        ? { type: 'page_id', page_id: parent.id }
        : { type: 'block_id', block_id: parent.id };
    const ids = insertBlocks(input.children as unknown[], ref);
    parent.children.splice(at, 0, ...ids);
    touch(parent);
    return c.json({
      object: 'list',
      results: ids.map((id) => blockJson(store.objects.get(id) as BlockRec)),
      next_cursor: null,
      has_more: false,
      type: 'block',
      block: {},
    });
  });

  app.delete('/v1/blocks/:id', (c) => {
    const obj = container(idParam(c));
    if (obj.archived) throw archivedError();
    obj.archived = true;
    touch(obj);
    return c.json(obj.kind === 'page' ? pageJson(c, obj) : blockJson(obj));
  });

  return {
    name: 'notion',
    description: `Notion API subset (${NOTION_API_VERSION}): OAuth, search, databases, pages, blocks.`,
    app,
    reset: () => {
      store = createStore(now);
      codes.clear();
      revoked.clear();
      throttle = { count: 0, retryAfter: 0 };
    },
  };
}

function emptyValue(type: string): unknown {
  switch (type) {
    case 'title':
    case 'rich_text':
    case 'multi_select':
    case 'people':
      return [];
    case 'checkbox':
      return false;
    default:
      return null;
  }
}

export type { RichText };
