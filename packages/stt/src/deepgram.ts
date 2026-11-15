import type { AudioFrame } from '@oat/audio';
import { WebSocket, type RawData } from 'ws';

import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.ts';
import {
  buildListenUrl,
  resolveDeepgramEndpoints,
  type GetDeepgramToken,
} from './deepgram-config.ts';
import { isDeepgramResults, mapDeepgramResults } from './deepgram-results.ts';
import { ReplayBuffer, SocketTimeline } from './replay.ts';
import { BaseSttStream } from './stream-base.ts';
import type { SttError, SttProvider, SttSource, SttStream, SttStreamOptions } from './types.ts';

export interface DeepgramConnectContext {
  source: SttSource;
  /** Recording ms of the first audio this connection will receive (`undefined` if none buffered yet). */
  offsetMs: number | undefined;
  /** 1 for the first connection of the stream, then 2, 3, … */
  attempt: number;
}

export interface DeepgramProviderOptions {
  /** Credential for each (re)connect (D-17: a short-lived token in clients). */
  getToken: GetDeepgramToken;
  /** Live websocket URL. Default: from env (`resolveDeepgramEndpoints()`), i.e. the mock in dev. */
  url?: string;
  /** Default `nova-3`. */
  model?: string;
  /** Silence (ms) that ends an utterance (`speech_final`), or `false`. Default 300. */
  endpointingMs?: number | false;
  /** Default `true`. */
  interimResults?: boolean;
  /** Default `true`. */
  smartFormat?: boolean;
  /** Opt out of Deepgram's model-improvement programme. Default `true`. */
  mipOptOut?: boolean;
  /** Audio kept per stream for replay after a reconnect (D-17: ≥ 120 s). Default 120 000. */
  replayBufferMs?: number;
  /** Send `KeepAlive` when no audio was sent for this long (paused, muted source). Default 3000. */
  keepAliveMs?: number;
  /**
   * Audio counts as paused after no frame for this long: the stream sends `Finalize` once, so the
   * utterance before the pause becomes final instead of hanging as an interim. Default 1000.
   */
  pauseFinalizeMs?: number;
  /**
   * Redial when audio is flowing (not paused) but the provider has said nothing for this long. Default
   * 30 000. A paused stream never stalls: the provider has nothing to say without audio.
   */
  stallTimeoutMs?: number;
  /** Handshake timeout. Default 10 000. */
  connectTimeoutMs?: number;
  /** Max wait in `finish()` for the last results. Default 15 000. */
  finishTimeoutMs?: number;
  reconnect?: Partial<BackoffOptions>;
  /**
   * Handshake auth rejections (401/403) tolerated before a fatal error; each retry calls
   * `getToken({ refresh: true })` so a cached token is replaced. Default 1.
   */
  authRetries?: number;
  /** Consecutive 429 (rate limited) handshakes tolerated before a fatal `quota` error. Default 5. */
  rateLimitRetries?: number;
  /**
   * Extra query parameters per connection. **Tests and dev tools only** (e.g. the mock's
   * `mock_fixture`/`mock_offset_ms`/`drop_after_ms`); production code paths never set this.
   */
  extraQuery?: (ctx: DeepgramConnectContext) => Record<string, string | number | boolean>;
  /** For tests: jitter source. */
  random?: () => number;
}

/**
 * Deepgram live transcription over a websocket per stream: linear16 mono at the frame rate, interim results,
 * smart formatting, endpointing, keyterms. Survives drops: reconnects with exponential backoff and replays
 * the audio the provider had not finalized from a rolling buffer, on the original recording clock, dropping
 * results it already emitted. Node only (uses `ws`, which can send an `Authorization` header and expose
 * handshake status codes); the desktop runs it in the Electron main process.
 */
export class DeepgramProvider implements SttProvider {
  readonly name = 'deepgram';
  readonly #options: DeepgramProviderOptions;

  constructor(options: DeepgramProviderOptions) {
    this.#options = options;
  }

  openStream(options: SttStreamOptions): SttStream {
    return new DeepgramStream(options, this.#options);
  }
}

interface Connection {
  ws: WebSocket;
  timeline: SocketTimeline;
  open: boolean;
  closeStreamSent: boolean;
  /** HTTP status when the handshake was refused. */
  handshakeStatus?: number;
  socketError?: Error;
  stalled: boolean;
  lastServerMessageAt: number;
  lastAudioSentAt: number;
  lastKeepAliveAt: number;
  /** When audio was first sent after the last server message (`undefined` = none since). */
  awaitingReplySince: number | undefined;
  /** Audio was sent since the last `Finalize` (so a pause has something to flush). */
  unflushedAudio: boolean;
}

const MAX_TICK_MS = 250;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function pcmBytes(pcm: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  pcm.forEach((v, i) => view.setInt16(i * 2, v, true));
  return out;
}

const now = () => performance.now();

class DeepgramStream extends BaseSttStream {
  readonly #opts: DeepgramProviderOptions;
  readonly #stream: SttStreamOptions;
  readonly #backoff: BackoffOptions;
  readonly #replay: ReplayBuffer;
  readonly #url: string;

  #conn: Connection | undefined;
  /** Recording-ms watermark of finalized audio (see `mapDeepgramResults`). */
  #committedMs: number | undefined;
  #firstUs: number | undefined;
  #reportedLostToUs = -Infinity;
  #attempt = 0;
  #failures = 0;
  #authFailures = 0;
  #rateLimited = 0;
  /** The last handshake was refused for auth: ask `getToken` for a new token, not a cached one. */
  #refreshToken = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #finishTimer: ReturnType<typeof setTimeout> | undefined;
  #finishing: Promise<void> | undefined;
  #resolveFinish: (() => void) | undefined;

  constructor(stream: SttStreamOptions, opts: DeepgramProviderOptions) {
    super(stream);
    this.#opts = opts;
    this.#stream = stream;
    this.#backoff = { ...DEFAULT_BACKOFF, ...opts.reconnect };
    this.#replay = new ReplayBuffer(opts.replayBufferMs ?? 120_000);
    this.#url = opts.url ?? resolveDeepgramEndpoints().listenUrl;
    queueMicrotask(() => void this.#connect());
  }

  write(frame: AudioFrame): void {
    this.checkFrame(frame);
    if (this.terminated || this.#finishing) return;
    this.#firstUs ??= frame.tUs;
    this.#replay.push(frame);
    const conn = this.#conn;
    if (conn?.open) this.#sendAudio(conn, frame);
  }

  finish(): Promise<void> {
    if (this.#finishing) return this.#finishing;
    this.#finishing = new Promise<void>((resolve) => (this.#resolveFinish = resolve));
    if (this.terminated) {
      this.#resolveFinish!();
      return this.#finishing;
    }
    const conn = this.#conn;
    if (conn?.open) this.#sendCloseStream(conn);
    // Otherwise the next successful open replays the tail and sends CloseStream.
    this.#finishTimer = setTimeout(() => {
      this.emitError({
        code: 'finish_timeout',
        message: `no final results within ${this.#opts.finishTimeoutMs ?? 15_000} ms of finish()`,
        fatal: false,
      });
      this.retractInterim();
      this.#shutdown();
    }, this.#opts.finishTimeoutMs ?? 15_000);
    return this.#finishing;
  }

  close(): void {
    this.#shutdown();
  }

  // --- connection lifecycle --------------------------------------------------------------------------

  async #connect(): Promise<void> {
    this.#retryTimer = undefined;
    if (this.terminated) return;
    const attempt = ++this.#attempt;
    if (attempt > 1) this.setStatus('reconnecting');

    let token;
    try {
      const refresh = this.#refreshToken;
      this.#refreshToken = false;
      token = await this.#opts.getToken(refresh ? { refresh: true } : undefined);
    } catch (error) {
      if (this.terminated) return;
      this.emitError({
        code: 'token',
        message: `getToken failed: ${describe(error)}`,
        fatal: false,
      });
      this.#scheduleReconnect();
      return;
    }
    if (this.terminated) return;

    const first = this.#replayFrames()[0];
    const url = buildListenUrl(
      this.#url,
      {
        sampleRate: this.sampleRate,
        model: this.#opts.model ?? 'nova-3',
        language: this.#stream.language,
        keyterms: this.#stream.keyterms,
        interimResults: this.#opts.interimResults ?? true,
        smartFormat: this.#opts.smartFormat ?? true,
        endpointingMs: this.#opts.endpointingMs ?? 300,
        mipOptOut: this.#opts.mipOptOut ?? true,
      },
      this.#opts.extraQuery?.({
        source: this.source,
        offsetMs: first ? first.tUs / 1000 : undefined,
        attempt,
      }),
    );
    const scheme = token.scheme === 'token' ? 'Token' : 'Bearer';
    const ws = new WebSocket(url, {
      headers: { Authorization: `${scheme} ${token.token}` },
      handshakeTimeout: this.#opts.connectTimeoutMs ?? 10_000,
      perMessageDeflate: false,
    });
    const t = now();
    const conn: Connection = {
      ws,
      timeline: new SocketTimeline(this.sampleRate),
      open: false,
      closeStreamSent: false,
      stalled: false,
      lastServerMessageAt: t,
      lastAudioSentAt: t,
      lastKeepAliveAt: t,
      awaitingReplySince: undefined,
      unflushedAudio: false,
    };
    this.#conn = conn;
    ws.on('unexpected-response', (_req, res) => {
      conn.handshakeStatus = res.statusCode;
      res.resume();
      ws.terminate(); // → 'error' + 'close'
    });
    ws.on('open', () => this.#onOpen(conn));
    ws.on('message', (data, isBinary) => this.#onMessage(conn, data, isBinary));
    ws.on('error', (error) => (conn.socketError = error));
    ws.on('close', (code, reason) => this.#onClose(conn, code, reason.toString()));
  }

  #onOpen(conn: Connection): void {
    if (conn !== this.#conn || this.terminated) return;
    conn.open = true;
    conn.lastServerMessageAt = now();
    this.#authFailures = 0;
    this.#rateLimited = 0;
    this.setStatus('open');

    // Audio evicted from the replay buffer before the provider finalized it is gone (D-17: the archive
    // back-fills it later). Compare against evictions, not the first buffered frame: a live source's
    // timeline jumps across a pause, which is not lost audio. Each lost range is reported once.
    const evictedEndUs = this.#replay.evictedEndUs;
    const lostFromUs = Math.max(
      this.#committedMs !== undefined ? this.#committedMs * 1000 : (this.#firstUs ?? Infinity),
      this.#reportedLostToUs,
    );
    if (evictedEndUs !== undefined && evictedEndUs - lostFromUs >= 1000) {
      this.#reportedLostToUs = evictedEndUs;
      this.emitError({
        code: 'replay_overflow',
        message: `${Math.round((evictedEndUs - lostFromUs) / 1000)} ms of audio fell out of the replay buffer while disconnected`,
        fatal: false,
        lostFromMs: Math.round(lostFromUs / 1000),
        lostToMs: Math.round(evictedEndUs / 1000),
      });
    }
    for (const frame of this.#replayFrames()) this.#sendAudio(conn, frame);
    if (this.#finishing) this.#sendCloseStream(conn);
    const tickMs = Math.max(
      10,
      Math.min(MAX_TICK_MS, this.#keepAliveMs / 4, this.#pauseFinalizeMs / 4),
    );
    this.#tickTimer ??= setInterval(() => this.#tick(), tickMs);
  }

  #onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    if (conn !== this.#conn || this.terminated) return;
    conn.lastServerMessageAt = now();
    conn.awaitingReplySince = undefined;
    this.#failures = 0;
    if (isBinary) return;

    let message: unknown;
    try {
      message = JSON.parse(rawToString(data));
    } catch {
      this.emitError({
        code: 'protocol',
        message: 'unparseable message from provider',
        fatal: false,
      });
      return;
    }
    if (isDeepgramResults(message)) {
      const { segment, chunkEndMs } = mapDeepgramResults(message, {
        source: this.source,
        toRecordingMs: (s) => conn.timeline.toRecordingMs(s),
        committedMs: this.#committedMs,
      });
      if (message.is_final)
        this.#committedMs = Math.max(this.#committedMs ?? -Infinity, chunkEndMs);
      if (segment) this.emitSegment(segment);
      else if (message.is_final) this.retractInterim();
      return;
    }
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'Error') {
      const m = message as { description?: unknown; message?: unknown };
      this.emitError({
        code: 'protocol',
        message: `provider error: ${String(m.description ?? m.message ?? 'unknown')}`,
        fatal: false,
      });
    }
    // Metadata, SpeechStarted, UtteranceEnd and unknown types need no action.
  }

  #onClose(conn: Connection, code: number, reason: string): void {
    if (conn !== this.#conn) return;
    this.#conn = undefined;
    this.#stopTick();
    if (this.terminated) return;

    if (this.#finishing && conn.closeStreamSent && code === 1000) {
      this.retractInterim(); // the provider flushed everything; nothing may stay provisional
      this.#shutdown();
      return;
    }

    const status = conn.handshakeStatus;
    if (status === 429) {
      this.#rateLimited++;
      const fatal = this.#rateLimited > (this.#opts.rateLimitRetries ?? 5);
      this.#fail({ code: 'quota', message: 'provider rate limit (HTTP 429)', fatal, status });
      if (!fatal) this.#scheduleReconnect();
      return;
    }
    if (status === 402) {
      this.#fail({
        code: 'quota',
        message: 'provider account has no credit (HTTP 402)',
        fatal: true,
        status,
      });
      return;
    }
    if (status === 401 || status === 403) {
      this.#refreshToken = true;
      this.#authFailures++;
      const fatal = this.#authFailures > (this.#opts.authRetries ?? 1);
      this.#fail({
        code: 'auth',
        message: `provider rejected the credentials (HTTP ${status})`,
        fatal,
        status,
      });
      if (!fatal) this.#scheduleReconnect();
      return;
    }
    if (status === 400) {
      this.#fail({
        code: 'bad_request',
        message: 'provider rejected the stream parameters (HTTP 400)',
        fatal: true,
        status,
      });
      return;
    }
    if (!conn.stalled) {
      const detail = conn.open
        ? `connection lost (close ${code}${reason ? `: ${reason}` : ''})`
        : `connect failed (${status !== undefined ? `HTTP ${status}` : describe(conn.socketError ?? `close ${code}`)})`;
      this.emitError({
        code: 'connection',
        message: detail,
        fatal: false,
        ...(status !== undefined ? { status } : { status: code }),
      });
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.terminated) return;
    this.#failures++;
    if (this.#failures > this.#backoff.maxAttempts) {
      this.#fail({
        code: 'connection',
        message: `gave up after ${this.#backoff.maxAttempts} reconnect attempts`,
        fatal: true,
      });
      return;
    }
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.#failures, this.#backoff, this.#opts.random);
    this.#retryTimer = setTimeout(() => void this.#connect(), delay);
  }

  get #keepAliveMs(): number {
    return this.#opts.keepAliveMs ?? 3000;
  }

  get #pauseFinalizeMs(): number {
    return this.#opts.pauseFinalizeMs ?? 1000;
  }

  #tick(): void {
    const conn = this.#conn;
    if (!conn?.open) return;
    const t = now();
    const silentFor = t - conn.lastAudioSentAt;
    const paused = silentFor >= this.#pauseFinalizeMs;
    if (paused && conn.unflushedAudio && !conn.closeStreamSent) {
      // Audio stopped (pause, mute, capture hiccup): have the provider finalize what it heard.
      conn.unflushedAudio = false;
      conn.ws.send(JSON.stringify({ type: 'Finalize' }));
    }
    if (silentFor >= this.#keepAliveMs && t - conn.lastKeepAliveAt >= this.#keepAliveMs) {
      conn.lastKeepAliveAt = t;
      conn.ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }
    const stallMs = this.#opts.stallTimeoutMs ?? 30_000;
    if (
      !paused &&
      conn.awaitingReplySince !== undefined &&
      t - conn.awaitingReplySince >= stallMs
    ) {
      conn.stalled = true;
      this.emitError({
        code: 'stall',
        message: `no message from the provider for ${stallMs} ms while sending audio; redialling`,
        fatal: false,
      });
      conn.ws.terminate();
    }
  }

  // --- helpers -----------------------------------------------------------------------------------------

  /** Buffered audio the provider has not finalized yet. */
  #replayFrames(): AudioFrame[] {
    return this.#replay.from(
      this.#committedMs !== undefined ? this.#committedMs * 1000 : -Infinity,
    );
  }

  #sendAudio(conn: Connection, frame: AudioFrame): void {
    conn.timeline.append(frame);
    conn.ws.send(pcmBytes(frame.pcm));
    const t = now();
    // Resuming after a pause: the wait for a reply starts now, not before the pause.
    if (t - conn.lastAudioSentAt >= this.#pauseFinalizeMs) conn.awaitingReplySince = undefined;
    conn.lastAudioSentAt = t;
    conn.awaitingReplySince ??= t;
    conn.unflushedAudio = true;
  }

  #sendCloseStream(conn: Connection): void {
    if (conn.closeStreamSent) return;
    conn.closeStreamSent = true;
    conn.ws.send(JSON.stringify({ type: 'CloseStream' }));
  }

  #stopTick(): void {
    clearInterval(this.#tickTimer);
    this.#tickTimer = undefined;
  }

  /** Emits the error; a fatal one also tears the stream down. */
  #fail(error: SttError): void {
    this.emitError(error);
    if (error.fatal) this.#shutdown();
  }

  /** Stops everything; status `closed` unless already terminal. Resolves a pending `finish()`. */
  #shutdown(): void {
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#finishTimer);
    this.#stopTick();
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn) {
      conn.ws.removeAllListeners();
      conn.ws.on('error', () => undefined);
      conn.ws.terminate();
    }
    this.#replay.clear();
    this.setStatus('closed');
    this.#resolveFinish?.();
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
