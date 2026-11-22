import { randomUUID } from 'node:crypto';

import { apiRoutes } from '@oat/client/routes';
import type { OatRequest } from '@oat/client';
import type { BridgeApiRequest } from '@oat/core/bridge';

import { ApiError, type createApiRequester } from './api-client.ts';
import type { AuthController } from './auth.ts';
import {
  BridgeError,
  subscribePayload,
  type ApiSender,
  type Bridge,
  type IpcEventLike,
} from './ipc.ts';
import type { MainStore } from './store.ts';

const safeId = /^[A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*$/;

export function apiProxyUrl(
  request: Pick<OatRequest, 'method' | 'path' | 'query'>,
  baseUrl: string,
): URL {
  const { path, method } = request;
  if (
    !path.startsWith('/api/') ||
    path.includes('..') ||
    path.includes('//') ||
    /[\\?#\s]/.test(path) ||
    /[^ -~]/.test(path) ||
    /%/i.test(path)
  ) {
    throw new BridgeError('forbidden', 'This API path is not allowed.');
  }
  const segments = path.split('/');
  const candidates = apiRoutes.filter((route) => {
    const pattern = route.path.split('/');
    return (
      pattern.length === segments.length &&
      pattern.every((part, index) =>
        part.startsWith('[') ? safeId.test(segments[index]!) : part === segments[index],
      )
    );
  });
  const priority = (pattern: string) =>
    pattern
      .split('/')
      .map((part) => (part.startsWith('[') ? '0' : '1'))
      .join('');
  const route = candidates.sort((a, b) => priority(b.path).localeCompare(priority(a.path)))[0];
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (!route?.methods.includes(method) || url.origin !== base.origin || url.pathname !== path) {
    throw new BridgeError('forbidden', 'This API path is not allowed.');
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

type Stream = {
  id: string;
  owner: ApiSender;
  abort: AbortController;
  started: boolean;
  cleanup(): void;
};

export function registerApiProxy(options: {
  bridge: Bridge;
  baseUrl: string;
  request: ReturnType<typeof createApiRequester>;
  auth: Pick<AuthController, 'withSession'>;
  store: Pick<MainStore, 'subscribe'>;
}) {
  const streams = new Map<string, Stream>();
  const { bridge, baseUrl, request, auth } = options;

  function end(stream: Stream, error?: { code: string; message: string }) {
    if (!streams.has(stream.id)) return;
    stream.cleanup();
    if (stream.started && !stream.owner.isDestroyed()) {
      stream.owner.send(
        'api:stream-end',
        subscribePayload('api:stream-end', { streamId: stream.id, ...(error ? { error } : {}) }),
      );
    }
  }
  function cancel(
    stream: Stream,
    error: { code: 'unavailable' | 'unauthorized' | 'forbidden'; message: string },
  ) {
    stream.abort.abort(new BridgeError(error.code, error.message));
    end(stream, error);
  }
  function track(owner: ApiSender): Stream {
    if (owner.isDestroyed()) throw new BridgeError('forbidden', 'This window has closed.');
    const stream: Stream = {
      id: randomUUID(),
      owner,
      abort: new AbortController(),
      started: false,
      cleanup: () => {
        streams.delete(stream.id);
        owner.removeListener('destroyed', destroyed);
        owner.removeListener('did-start-navigation', navigated);
      },
    };
    const destroyed = () =>
      cancel(stream, { code: 'forbidden', message: 'This window has closed.' });
    const navigated = () =>
      cancel(stream, { code: 'forbidden', message: 'This window navigated.' });
    owner.on('destroyed', destroyed);
    owner.on('did-start-navigation', navigated);
    streams.set(stream.id, stream);
    return stream;
  }
  function sender(event: IpcEventLike): ApiSender {
    if (!event.sender || event.sender.isDestroyed())
      throw new BridgeError('forbidden', 'This window has closed.');
    return event.sender;
  }

  async function fetchApi(
    input: BridgeApiRequest,
    signal?: AbortSignal,
    streaming = false,
  ): Promise<Response> {
    const url = apiProxyUrl(input, baseUrl);
    let rejected: Response | undefined;
    try {
      return await auth.withSession(async (token) => {
        const response = await request(url.pathname + url.search, {
          method: input.method,
          token,
          signal,
          ...(streaming ? { timeoutMs: null } : {}),
          ...(input.body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body) }
            : {}),
        });
        if (response.status === 401) {
          // Detach the error envelope before signing out aborts this session's streams.
          rejected = new Response(await response.text(), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
          throw new ApiError(401, 'Your session has ended.');
        }
        return response;
      });
    } catch (error) {
      if (rejected) return rejected;
      if (error instanceof ApiError) {
        throw new BridgeError(
          error.unauthorized ? 'unauthorized' : 'unavailable',
          error.unauthorized ? 'Not signed in.' : 'Couldn’t reach Oat.',
        );
      }
      throw error;
    }
  }

  bridge.handle('api:request', async (input) => {
    const response = await fetchApi(input);
    try {
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    } catch {
      if (!response.ok) return { status: response.status, body: null };
      throw new BridgeError('unavailable', 'Oat returned an unreadable JSON response.');
    }
  });

  async function pump(stream: Stream, response: Response) {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    try {
      if (reader) {
        while (!stream.abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (stream.abort.signal.aborted) return;
          const chunk = decoder.decode(value, { stream: !done });
          if (chunk && !stream.owner.isDestroyed()) {
            stream.owner.send(
              'api:stream-chunk',
              subscribePayload('api:stream-chunk', { streamId: stream.id, chunk }),
            );
          }
          if (done) break;
        }
      }
      end(stream);
    } catch {
      end(stream, { code: 'unavailable', message: 'The Oat stream was interrupted.' });
    } finally {
      try {
        await reader?.cancel();
      } catch {
        /* The source may already have failed. */
      }
      reader?.releaseLock();
    }
  }

  bridge.handle('api:stream-open', async (input, event) => {
    const owner = sender(event);
    // Validate before allocating lifecycle listeners.
    apiProxyUrl(input, baseUrl);
    let stream = track(owner);
    try {
      const response = await fetchApi(input, stream.abort.signal, true);
      if (stream.abort.signal.aborted) {
        if (
          response.status !== 401 ||
          !(stream.abort.signal.reason instanceof BridgeError) ||
          stream.abort.signal.reason.code !== 'unauthorized'
        ) {
          await response.body?.cancel().catch(() => {});
          throw stream.abort.signal.reason;
        }
        stream = track(owner);
      }
      const type = response.headers.get('content-type') ?? '';
      if (type && !/^(text\/|application\/(json|.*\+json)(;|$))/i.test(type)) {
        await response.body?.cancel().catch(() => {});
        throw new BridgeError('unavailable', 'This text bridge does not support binary downloads.');
      }
      const headers: Record<string, string> = {};
      for (const key of [
        'content-type',
        'cache-control',
        'x-vercel-ai-ui-message-stream',
        'x-oat-thread-id',
      ]) {
        const value = response.headers.get(key);
        if (value !== null) headers[key] = value;
      }
      stream.started = true;
      void pump(stream, response);
      return { streamId: stream.id, status: response.status, headers };
    } catch (error) {
      stream.cleanup();
      throw error;
    }
  });
  bridge.handle('api:stream-cancel', ({ streamId }, event) => {
    const stream = streams.get(streamId);
    const owner = sender(event);
    if (!stream) return;
    if (stream.owner.id !== owner.id)
      throw new BridgeError('forbidden', 'This stream belongs to another window.');
    cancel(stream, { code: 'unavailable', message: 'Stream cancelled.' });
  });

  const unsubscribe = options.store.subscribe(({ state }) => {
    if (state.auth.status !== 'signed-in') {
      for (const stream of [...streams.values()])
        cancel(stream, { code: 'unauthorized', message: 'Not signed in.' });
    }
  });
  return {
    cancelAll() {
      for (const stream of [...streams.values()])
        cancel(stream, { code: 'unauthorized', message: 'Not signed in.' });
    },
    dispose() {
      unsubscribe();
      for (const stream of [...streams.values()])
        cancel(stream, { code: 'unavailable', message: 'API proxy closed.' });
    },
  };
}
