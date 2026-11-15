import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp, type CreateAppOptions, type MocksApp } from './app.ts';

export interface StartMocksOptions extends CreateAppOptions {
  /** Default 0 = a random free port (what tests want). */
  port?: number;
  /** Default 127.0.0.1. */
  hostname?: string;
}

export interface RunningMocks extends MocksApp {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:53211`. Use as `MOCKS_URL`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the mocks service on a real HTTP server (HTTP + provider websockets). Integration tests for a
 * provider use this in-process instance rather than the shared container, so they always test the code
 * in their own checkout and never see or disturb other worktrees' state. `main.ts` uses it too.
 */
export function startMocks(options: StartMocksOptions = {}): Promise<RunningMocks> {
  const mocks = createApp(options);
  const hostname = options.hostname ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: mocks.app.fetch, port: options.port ?? 0, hostname }) as Server;
    server.on('upgrade', mocks.handleUpgrade);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      const { port } = server.address() as AddressInfo;
      const host = hostname.includes(':') ? `[${hostname}]` : hostname;
      resolve({
        ...mocks,
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            mocks.closeWebSockets();
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
