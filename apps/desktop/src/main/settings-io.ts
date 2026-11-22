import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

import type { InvokeRequest } from '@oat/core/bridge';

import { ApiError, type createApiRequester } from './api-client';
import { BridgeError } from './ipc';

type Options = {
  baseUrl: string;
  withSession: <T>(run: (token: string) => Promise<T>) => Promise<T>;
  request: ReturnType<typeof createApiRequester>;
  chooseZip: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
};

async function check(response: Response) {
  if (response.ok) return;
  const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new ApiError(
    response.status,
    data?.error?.message ?? 'Oat couldn’t complete this request.',
  );
}

function asSettingsError(error: unknown, fallback: string): BridgeError {
  if (error instanceof ApiError) {
    if (error.status === 401) return new BridgeError('unauthorized', 'Sign in first.');
    if (error.status === 403) return new BridgeError('forbidden', error.message);
    return new BridgeError('unavailable', error.message);
  }
  return new BridgeError('unavailable', fallback);
}

export function createSettingsIo(options: Options) {
  return {
    async exportNotes({ workspaceId }: InvokeRequest<'settings:export-notes'>) {
      try {
        return await options.withSession(async (token) => {
          const path = await options.chooseZip();
          if (!path) return null;
          const response = await options.request(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/export`,
            { token, timeoutMs: 120_000 },
          );
          await check(response);
          const count = response.headers.get('x-oat-export-count');
          if (
            !response.body ||
            response.headers.get('content-type')?.split(';')[0] !== 'application/zip' ||
            count === null ||
            !/^\d+$/.test(count)
          ) {
            await response.body?.cancel();
            throw new Error('Invalid export response');
          }
          const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.partial`);
          try {
            await pipeline(
              Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
              createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
            );
            await rename(temp, path);
          } finally {
            await rm(temp, { force: true });
          }
          return { count: Number(count) };
        });
      } catch (error) {
        throw asSettingsError(error, 'Couldn’t export your notes. Nothing was saved — try again.');
      }
    },

    async connect(input: InvokeRequest<'settings:connect'>) {
      try {
        const url = await options.withSession(async (token) => {
          const response = await options.request('/api/settings/consent', {
            method: 'POST',
            token,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          });
          await check(response);
          const data = (await response.json()) as { url?: unknown };
          if (typeof data.url !== 'string') throw new Error('Missing consent URL');
          const target = new URL(data.url);
          if (
            target.origin !== new URL(options.baseUrl).origin ||
            target.pathname !== '/api/settings/consent/browser' ||
            target.username ||
            target.password ||
            target.hash ||
            !/^\?ticket=[A-Za-z0-9_-]{43}$/.test(target.search)
          )
            throw new Error('Invalid consent URL');
          return target.href;
        });
        await options.openExternal(url);
      } catch (error) {
        throw asSettingsError(error, 'Couldn’t open provider consent. Try again.');
      }
    },
  };
}
