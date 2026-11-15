import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import type { MockProvider, MockProviderFactory, MockWebSocketRoute } from './provider.ts';
import { defaultProviders } from './providers/index.ts';
import { MAX_BODY_CHARS, RequestLog } from './request-log.ts';

export interface CreateAppOptions {
  /** Defaults to every registered provider (`src/providers/index.ts`). */
  providers?: MockProviderFactory[];
  /** Ring-buffer size for `GET /_requests`. Default 500. */
  logCapacity?: number;
}

export interface MocksApp {
  app: Hono;
  log: RequestLog;
  providers: MockProvider[];
  /** Node `server.on('upgrade', …)` handler for provider websockets. `startMocks()` wires it up. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Terminates open provider websockets (for shutdown). */
  closeWebSockets: () => void;
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Reserved for the service itself; providers can't use them. */
const RESERVED = new Set(['health', '_requests', '_reset']);

/** Credentials never end up in the request log; the scheme is kept so tests can still assert it. */
function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key === 'authorization' || key === 'proxy-authorization') {
      const scheme = value.split(' ')[0] ?? '';
      out[key] = value.includes(' ') ? `${scheme} [redacted]` : '[redacted]';
    } else if (key === 'x-api-key' || key === 'api-key' || key === 'cookie') {
      out[key] = '[redacted]';
    } else {
      out[key] = value;
    }
  });
  return out;
}

function toHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

export function createApp(options: CreateAppOptions = {}): MocksApp {
  const log = new RequestLog(options.logCapacity);
  const providers = (options.providers ?? defaultProviders).map((create) => create());

  const seen = new Set<string>();
  for (const p of providers) {
    if (!PROVIDER_NAME.test(p.name) || RESERVED.has(p.name)) {
      throw new Error(`invalid mock provider name: "${p.name}"`);
    }
    if (seen.has(p.name)) throw new Error(`duplicate mock provider name: "${p.name}"`);
    seen.add(p.name);
  }
  const byName = new Map(providers.map((p) => [p.name, p]));

  const app = new Hono();

  // Record every provider call (service routes like /health and /_* are not recorded).
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path.startsWith('/_')) return next();
    const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    // Hono caches the body, so providers can still call c.req.json()/text() afterwards.
    const text = hasBody ? await c.req.text() : '';
    await next();
    log.add({
      at: new Date().toISOString(),
      method: c.req.method,
      path,
      provider: path.split('/')[1] ?? '',
      query: c.req.query(),
      headers: redactHeaders(c.req.raw.headers),
      body: hasBody && text !== '' ? text.slice(0, MAX_BODY_CHARS) : null,
      status: c.res.status,
    });
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: '@oat/mocks',
      providers: providers.map(({ name, description }) => ({ name, description })),
    }),
  );

  app.get('/_requests', (c) => {
    const { provider, since, limit } = c.req.query();
    const num = (v: string | undefined) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
    };
    const sinceN = num(since);
    const limitN = num(limit);
    if (Number.isNaN(sinceN) || Number.isNaN(limitN)) {
      return c.json({ error: 'since and limit must be non-negative integers' }, 400);
    }
    return c.json({ requests: log.list({ provider, since: sinceN, limit: limitN }) });
  });

  // `?provider=<name>` resets only that provider (state + its log entries): use this from tests, since
  // the container is shared. The unscoped form resets everything and is meant for humans.
  app.post('/_reset', (c) => {
    const name = c.req.query('provider');
    if (name === undefined) {
      log.clear();
      for (const p of providers) p.reset?.();
      return c.json({ ok: true });
    }
    const provider = byName.get(name);
    if (!provider) return c.json({ error: 'unknown_provider', provider: name }, 404);
    log.clear(name);
    provider.reset?.();
    return c.json({ ok: true, provider: name });
  });

  for (const p of providers) app.route(`/${p.name}`, p.app);

  app.notFound((c) => c.json({ error: 'not_found', method: c.req.method, path: c.req.path }, 404));
  app.onError((err, c) => {
    console.error('[mocks] unhandled error', err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  // Websockets: `/<provider><route.path>`, upgrades logged like HTTP calls (status 101 or 404).
  const routes = new Map<string, MockWebSocketRoute>();
  for (const p of providers) {
    for (const route of p.websockets ?? []) routes.set(`/${p.name}${route.path}`, route);
  }
  const wss = new WebSocketServer({ noServer: true });

  const handleUpgrade: MocksApp['handleUpgrade'] = (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const route = routes.get(url.pathname);
    log.add({
      at: new Date().toISOString(),
      method: request.method ?? 'GET',
      path: url.pathname,
      provider: url.pathname.split('/')[1] ?? '',
      query: Object.fromEntries(url.searchParams),
      headers: redactHeaders(toHeaders(request.headers)),
      body: null,
      status: route ? 101 : 404,
    });
    if (!route) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => route.handle(ws, request, url));
  };

  const closeWebSockets = () => {
    for (const client of wss.clients) client.terminate();
  };

  return { app, log, providers, handleUpgrade, closeWebSockets };
}
