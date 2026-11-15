/**
 * The desktop end of the SSE invalidation channel (`GET /api/sync/events`, D-19, task 3.5). Main process
 * only (the bearer token never leaves main). It doesn't carry data: every `change` event (and every
 * (re)connect, which may have missed some) just tells the sync engine to pull now; the engine's 60 s
 * interval stays as the backstop when the channel is down.
 *
 * - Reconnects with `Last-Event-ID` (the server replays what was missed) and exponential backoff with
 *   jitter (1 s → 30 s), reset once a connection delivers something.
 * - A connection that goes quiet for `idleTimeoutMs` (the server sends a heartbeat every 15 s) is dropped
 *   and reopened — sleep/wake and dead Wi-Fi leave half-open sockets behind.
 * - 401: stops (the session is gone; the app signs out through the normal path).
 */
import { type SyncEvent, syncEventSchema } from '@oat/core/sync';

export interface SyncEventsOptions {
  /** Opens the stream (fetch with the bearer). A 401 must reject with a `status: 401` error. */
  connect(lastEventId: string | null, signal: AbortSignal): Promise<Response>;
  /** Something changed on the server. */
  onEvent(event: SyncEvent): void;
  /** A connection is up (it may have missed events while it was down: pull). */
  onOpen(): void;
  log?: { info(message: string): void; warn(message: string): void };
  setTimer?: (fn: () => void, ms: number) => () => void;
  random?: () => number;
  backoffMs?: number;
  maxBackoffMs?: number;
  idleTimeoutMs?: number;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

export interface ParsedSseEvent {
  id: string | null;
  event: string;
  data: string;
}

/** Incremental `text/event-stream` parser: feed chunks, get complete events (comments dropped). */
export class SseParser {
  #buffer = '';

  push(chunk: string): ParsedSseEvent[] {
    this.#buffer += chunk.replace(/\r\n?/g, '\n');
    const out: ParsedSseEvent[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf('\n\n')) >= 0) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let id: string | null = null;
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = value;
        else if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0 || id !== null) out.push({ id, event, data: data.join('\n') });
    }
    return out;
  }
}

export class SyncEventsClient {
  readonly #o: SyncEventsOptions;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  #running = false;
  #abort: AbortController | null = null;
  #cancelRetry: (() => void) | null = null;
  #failures = 0;
  #lastEventId: string | null = null;
  #connected = false;

  constructor(options: SyncEventsOptions) {
    this.#o = options;
    this.#setTimer = options.setTimer ?? defaultTimer;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#failures = 0;
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    this.#connected = false;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const ok = await this.#connectOnce();
      if (!this.#running) return;
      if (ok === 'unauthorized') {
        this.#o.log?.warn('sync events: unauthorized; stopped');
        this.stop();
        return;
      }
      if (ok === 'delivered') this.#failures = 0;
      else this.#failures += 1;
      const base = this.#o.backoffMs ?? 1_000;
      const delay =
        this.#failures === 0
          ? base
          : Math.min(this.#o.maxBackoffMs ?? 30_000, base * 2 ** (this.#failures - 1));
      const jittered = Math.round(delay * (0.75 + 0.5 * (this.#o.random ?? Math.random)()));
      await new Promise<void>((resolve) => {
        this.#cancelRetry = this.#setTimer(() => {
          this.#cancelRetry = null;
          resolve();
        }, jittered);
        if (!this.#running) resolve();
      });
    }
  }

  /** One connection, until it ends. `delivered` = it got at least one event. */
  async #connectOnce(): Promise<'delivered' | 'failed' | 'unauthorized'> {
    const abort = new AbortController();
    this.#abort = abort;
    let delivered = false;
    let cancelIdle: (() => void) | null = null;
    const armIdle = () => {
      cancelIdle?.();
      cancelIdle = this.#setTimer(() => abort.abort(), this.#o.idleTimeoutMs ?? 45_000);
    };
    try {
      armIdle();
      const res = await this.#o.connect(this.#lastEventId, abort.signal);
      if (res.status === 401) return 'unauthorized';
      if (!res.ok || !res.body) {
        this.#o.log?.warn(`sync events: HTTP ${res.status}`);
        await res.body?.cancel().catch(() => {});
        return 'failed';
      }
      const parser = new SseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !this.#running) break;
          armIdle();
          for (const e of parser.push(value)) {
            if (e.id !== null && e.id !== '') this.#lastEventId = e.id;
            if (e.event === 'ready') {
              delivered = true;
              this.#connected = true;
              this.#o.onOpen();
            } else if (e.event === 'change') {
              delivered = true;
              const parsed = syncEventSchema.safeParse(safeJson(e.data));
              if (parsed.success) this.#o.onEvent(parsed.data);
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return delivered ? 'delivered' : 'failed';
    } catch (error) {
      if ((error as { status?: number }).status === 401) return 'unauthorized';
      if (this.#running && !abort.signal.aborted) {
        this.#o.log?.info(`sync events: ${error instanceof Error ? error.message : String(error)}`);
      }
      return delivered ? 'delivered' : 'failed';
    } finally {
      (cancelIdle as (() => void) | null)?.();
      this.#connected = false;
      if (this.#abort === abort) this.#abort = null;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
