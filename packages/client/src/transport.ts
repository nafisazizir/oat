export type OatRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  stream?: boolean;
};

export type OatResponse = {
  status: number;
  headers?: Record<string, string>;
  json(): Promise<unknown>;
  body?: ReadableStream<Uint8Array> | null;
};

export type OatTransport = (request: OatRequest) => Promise<OatResponse>;

export class OatApiError extends Error {
  override readonly name = 'OatApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const LOCAL_ORIGIN = 'https://oat.invalid';

export function assertApiPath(path: string): void {
  const url = new URL(path, LOCAL_ORIGIN);
  if (
    !path.startsWith('/api/') ||
    path.includes('\\') ||
    url.origin !== LOCAL_ORIGIN ||
    url.pathname !== path ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Expected an /api/* path without a query or fragment.');
  }
}

export function requestPath(request: Pick<OatRequest, 'path' | 'query'>): string {
  assertApiPath(request.path);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return request.path + (query.size ? '?' + query.toString() : '');
}

export function fetchTransport(
  options: {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    credentials?: RequestCredentials;
  } = {},
): OatTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  return async (request) => {
    const response = await fetcher(base + requestPath(request), {
      method: request.method,
      credentials: options.credentials ?? 'same-origin',
      signal: request.signal,
      ...(request.body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) }
        : {}),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      json: () => response.json(),
      body: response.body,
    };
  };
}

export async function transportRequest(
  transport: OatTransport,
  request: OatRequest,
): Promise<OatResponse> {
  request.signal?.throwIfAborted();
  try {
    const response = await transport(request);
    request.signal?.throwIfAborted();
    if (response.status === 0)
      throw new OatApiError(0, 'unavailable', 'Couldn’t reach Oat. Check your connection.');
    return response;
  } catch (error) {
    request.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof OatApiError) throw error;
    throw new OatApiError(0, 'unavailable', 'Couldn’t reach Oat. Check your connection.', error);
  }
}

export async function checkResponse(response: OatResponse): Promise<void> {
  if (response.status >= 200 && response.status < 300) return;
  let details: unknown;
  try {
    details = await response.json();
  } catch {
    /* Not every proxy error is JSON. */
  }
  const error =
    details && typeof details === 'object' && 'error' in details ? details.error : undefined;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    throw new OatApiError(response.status, error.code, error.message, details);
  }
  throw new OatApiError(
    response.status,
    'http_error',
    'Oat request failed (' + response.status + ').',
    details,
  );
}

export async function asFetchResponse(response: OatResponse): Promise<Response> {
  const headers = new Headers(response.headers);
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return new Response(null, { status: response.status, headers });
  }
  if (response.body) return new Response(response.body, { status: response.status, headers });
  const json = await response.json();
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(json), { status: response.status, headers });
}

/** Fetch semantics: HTTP errors remain Responses; only transport failures reject. */
export function toFetch(transport: OatTransport): typeof globalThis.fetch {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, LOCAL_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new TypeError('Expected an HTTP API URL.');
    assertApiPath(url.pathname);
    const request = new Request(input instanceof Request ? input : url, init);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      throw new TypeError('Unsupported Oat request method.');
    }
    const text = request.body ? await request.text() : undefined;
    const entries = [...url.searchParams];
    const query = Object.fromEntries(entries);
    if (Object.keys(query).length !== entries.length) {
      throw new TypeError('Repeated query parameters are not supported.');
    }
    return asFetchResponse(
      await transportRequest(transport, {
        method: request.method as OatRequest['method'],
        path: url.pathname,
        query,
        ...(text !== undefined ? { body: JSON.parse(text) as unknown } : {}),
        signal: request.signal,
        stream: true,
      }),
    );
  };
}
