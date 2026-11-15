import type { IncomingMessage } from 'node:http';
import type { Hono } from 'hono';
import type { WebSocket } from 'ws';

/**
 * A websocket endpoint of a provider, e.g. a Deepgram-style streaming STT socket. `path` is relative to the
 * provider prefix and matched exactly against the URL pathname (`/listen` → `/<provider>/listen`).
 * Websockets only work on a real server (`startMocks()` / the container), not via `app.request()`.
 */
export interface MockWebSocketRoute {
  path: string;
  /** Called once the upgrade succeeded. `url` includes the query string the client connected with. */
  handle(socket: WebSocket, request: IncomingMessage, url: URL): void;
}

/**
 * A mocked third-party API. Each provider is a Hono sub-app mounted at `/<name>` (e.g. `/llm`, `/stt`,
 * `/notion`, `/gcal`). Providers keep their state in the closure of their factory so every `createApp()`
 * gets a fresh, isolated instance.
 */
export interface MockProvider {
  /** URL prefix (without slash). Lowercase letters, digits and dashes. */
  name: string;
  /** One line: which real service this stands in for. Shown at `GET /health`. */
  description: string;
  app: Hono;
  /** Websocket endpoints under `/<name>`. */
  websockets?: MockWebSocketRoute[];
  /** Clears in-memory state. Called by `POST /_reset` and `POST /_reset?provider=<name>`. */
  reset?: () => void;
}

export type MockProviderFactory = () => MockProvider;
