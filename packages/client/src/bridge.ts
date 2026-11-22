import type { OatBridge, BridgeApiRequest } from '@oat/core/bridge';

import { OatApiError, type OatRequest, type OatTransport } from './transport.ts';

type ApiBridge = Pick<OatBridge, 'invoke' | 'subscribe'>;
type Chunk = { streamId: string; chunk: string };
type End = { streamId: string; error?: { code: string; message: string } };
const bridgeError = (error: { code: string; message: string }) =>
  new OatApiError(
    error.code === 'unauthorized' ? 401 : error.code === 'forbidden' ? 403 : 0,
    error.code,
    error.message,
  );

function input(request: OatRequest): BridgeApiRequest {
  return {
    method: request.method,
    path: request.path,
    ...(request.query
      ? {
          query: Object.fromEntries(
            Object.entries(request.query).filter(([, value]) => value !== undefined),
          ),
        }
      : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  } as BridgeApiRequest;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Structural bridge dependency only: no Electron or renderer globals. */
export function bridgeTransport(oat: ApiBridge): OatTransport {
  return async (request) => {
    request.signal?.throwIfAborted();
    if (!request.stream) {
      const result = await abortable(oat.invoke('api:request', input(request)), request.signal);
      if (!result.ok) throw bridgeError(result.error);
      return { status: result.value.status, json: async () => result.value.body };
    }

    let streamId: string | undefined;
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const buffered: (Chunk | End)[] = [];
    const encoder = new TextEncoder();
    let unChunk = () => {};
    let unEnd = () => {};
    const cleanup = () => {
      unChunk();
      unEnd();
      request.signal?.removeEventListener('abort', abort);
    };
    const cancel = async () => {
      if (streamId) {
        try {
          await oat.invoke('api:stream-cancel', { streamId });
        } catch {
          /* Closing a window may close IPC first. */
        }
      }
    };
    const abort = () => {
      if (finished) return;
      finished = true;
      controller?.error(request.signal?.reason);
      cleanup();
      void cancel();
    };
    function receive(event: Chunk | End) {
      if (finished) return;
      if (!streamId || !controller) {
        buffered.push(event);
        return;
      }
      if (event.streamId !== streamId) return;
      if ('chunk' in event) controller.enqueue(encoder.encode(event.chunk));
      else {
        finished = true;
        if (event.error) controller.error(bridgeError(event.error));
        else controller.close();
        cleanup();
      }
    }
    unChunk = oat.subscribe('api:stream-chunk', receive);
    unEnd = oat.subscribe('api:stream-end', receive);
    request.signal?.addEventListener('abort', abort, { once: true });
    const opening = oat
      .invoke('api:stream-open', input(request))
      .then(async (result) => {
        if (!result.ok) throw bridgeError(result.error);
        streamId = result.value.streamId;
        if (finished) {
          await cancel();
          throw request.signal?.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            for (const event of buffered) receive(event);
            buffered.length = 0;
          },
          async cancel() {
            finished = true;
            cleanup();
            await cancel();
          },
        });
        return {
          status: result.value.status,
          headers: result.value.headers,
          body,
          json: () => new Response(body).json() as Promise<unknown>,
        };
      })
      .catch((error: unknown) => {
        finished = true;
        cleanup();
        throw error;
      });
    return abortable(opening, request.signal);
  };
}
