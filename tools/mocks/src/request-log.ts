/** One request as seen by the mocks service; exposed at `GET /_requests` so tests can assert calls were made. */
export interface LoggedRequest {
  /** Monotonic id, unique for the lifetime of the process (not reset by `POST /_reset`). */
  id: number;
  at: string;
  method: string;
  /** Path including the provider prefix, e.g. `/example/echo`. */
  path: string;
  /** First path segment, e.g. `example`; `''` for root-level routes. */
  provider: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Request body as text (truncated to `MAX_BODY_CHARS`), or `null` when there is none. */
  body: string | null;
  status: number;
}

export const MAX_BODY_CHARS = 64 * 1024;

/** Fixed-size ring buffer: keeps the most recent `capacity` requests, oldest dropped first. */
export class RequestLog {
  readonly capacity: number;
  #items: LoggedRequest[] = [];
  #nextId = 1;

  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  add(entry: Omit<LoggedRequest, 'id'>): LoggedRequest {
    const item = { id: this.#nextId++, ...entry };
    this.#items.push(item);
    if (this.#items.length > this.capacity) this.#items.shift();
    return item;
  }

  /** Oldest first. */
  list(filter: { provider?: string; since?: number; limit?: number } = {}): LoggedRequest[] {
    let items = this.#items;
    if (filter.provider !== undefined) items = items.filter((r) => r.provider === filter.provider);
    if (filter.since !== undefined) {
      const since = filter.since;
      items = items.filter((r) => r.id > since);
    }
    if (filter.limit !== undefined) items = items.slice(-filter.limit);
    return [...items];
  }

  /** Drops every entry, or only one provider's entries. */
  clear(provider?: string): void {
    this.#items = provider === undefined ? [] : this.#items.filter((r) => r.provider !== provider);
  }

  get size(): number {
    return this.#items.length;
  }
}
