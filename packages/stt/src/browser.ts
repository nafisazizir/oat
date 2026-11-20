import type { AudioFrame } from '@oat/audio';

import { backoffDelay } from './backoff.ts';
import { buildListenUrl } from './listen-url.ts';
import { isDeepgramResults, mapDeepgramResults } from './deepgram-results.ts';
import { frameEndUs, SocketTimeline } from './replay.ts';
import { BaseSttStream } from './stream-base.ts';
import type { SttStreamOptions } from './types.ts';

export type { SttSegment, SttStream, SttError, SttStatus } from './types.ts';
export type { AudioFrame } from '@oat/audio';
export interface BrowserToken {
  listenUrl: string;
  accessToken: string;
  keyterms: string[];
}

export interface BrowserSocket {
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

/** One browser socket per source. Unacknowledged PCM stays in memory until a final commits it. */
export class BrowserSttStream extends BaseSttStream {
  #frames: AudioFrame[] = [];
  #unsent: AudioFrame[] = [];
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #endSent = false;
  #socket: BrowserSocket | undefined;
  #timeline: SocketTimeline;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #watch: ReturnType<typeof setTimeout> | undefined;
  #finishWatch: ReturnType<typeof setTimeout> | undefined;
  #lastMessage = Date.now();
  #lastAudio = 0;
  #keepAlive: ReturnType<typeof setInterval>;
  #attempt = 0;
  #generation = 0;
  #committedUs: number | undefined;
  #finishing = false;
  #finish: Promise<void> | undefined;
  #resolve: (() => void) | undefined;
  readonly #getToken: () => Promise<BrowserToken>;
  readonly #connect: (url: string, protocols: string[]) => BrowserSocket;

  constructor(
    options: SttStreamOptions & {
      getToken: () => Promise<BrowserToken>;
      socket?: (url: string, protocols: string[]) => BrowserSocket;
    },
  ) {
    super(options);
    this.#getToken = options.getToken;
    this.#connect =
      options.socket ??
      ((url, protocols) => new globalThis.WebSocket(url, protocols) as unknown as BrowserSocket);
    this.#timeline = new SocketTimeline(this.sampleRate);
    this.#keepAlive = setInterval(() => {
      if (Date.now() - this.#lastAudio < 5000 && Date.now() - this.#lastMessage > 30000) {
        this.#lost('STT stopped responding; reconnecting with buffered audio.');
        return;
      }
      if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 3000);
    void this.#open();
  }

  get committedMs() {
    return this.#committedUs === undefined ? undefined : this.#committedUs / 1000;
  }

  async #open() {
    const generation = ++this.#generation;
    this.#watch = setTimeout(
      () => this.#lost('STT connection timed out; audio is buffered.'),
      10000,
    );
    try {
      const token = await this.#getToken();
      if (this.terminated || generation !== this.#generation) return;
      const socket = this.#connect(
        buildListenUrl(token.listenUrl, {
          sampleRate: this.sampleRate,
          model: 'nova-3',
          interimResults: true,
          smartFormat: true,
          endpointingMs: 300,
          mipOptOut: true,
          keyterms: token.keyterms,
        }),
        ['bearer', token.accessToken],
      );
      this.#socket = socket;
      this.#endSent = false;
      this.#timeline = new SocketTimeline(this.sampleRate);
      socket.onopen = () => {
        clearTimeout(this.#watch);
        this.#attempt = 0;
        this.#lastMessage = Date.now();
        this.setStatus('open');
        this.#unsent = [...this.#frames];
        this.#drain();
      };
      socket.onmessage = ({ data }) => {
        this.#lastMessage = Date.now();
        try {
          const message: unknown = JSON.parse(String(data));
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'Error'
          ) {
            this.#lost('STT reported an error; reconnecting with buffered audio.');
            return;
          }
          if (!isDeepgramResults(message)) return;
          const mapped = mapDeepgramResults(message, {
            source: this.source,
            toRecordingMs: (s) => this.#timeline.toRecordingMs(s),
            committedMs: this.committedMs,
          });
          if (mapped.segment) this.emitSegment(mapped.segment);
          else if (message.is_final) this.retractInterim();
          if (message.is_final) {
            this.#committedUs = Math.max(
              this.#committedUs ?? 0,
              Math.round(mapped.chunkEndMs * 1000),
            );
            this.#frames = this.#frames.filter((f) => frameEndUs(f) > this.#committedUs!);
          }
        } catch {
          this.emitError({
            code: 'protocol',
            message: 'Could not read an STT response.',
            fatal: false,
          });
        }
      };
      socket.onerror = () => this.#lost('STT is disconnected; audio is buffered and will replay.');
      socket.onclose = () => {
        if (this.#finishing) this.close();
        else this.#lost('STT disconnected; retrying with buffered audio.');
      };
    } catch {
      if (!this.terminated && generation === this.#generation)
        this.#lost('Could not connect to STT; retrying with buffered audio.');
    }
  }

  #detach() {
    clearTimeout(this.#drainTimer);
    this.#unsent = [];
    if (this.#socket) {
      this.#socket.onopen =
        this.#socket.onmessage =
        this.#socket.onerror =
        this.#socket.onclose =
          null;
      this.#socket.close();
      this.#socket = undefined;
    }
  }

  #lost(message: string) {
    if (this.terminated) return;
    ++this.#generation;
    clearTimeout(this.#watch);
    this.#detach();
    this.setStatus('reconnecting');
    this.emitError({ code: 'connection', message, fatal: false });
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => void this.#open(), backoffDelay(++this.#attempt));
  }

  retry() {
    if (this.terminated) return;
    this.#lost('Reconnecting to STT; buffered audio is retained.');
    clearTimeout(this.#retry);
    void this.#open();
  }

  #send(frame: AudioFrame) {
    if (!this.#socket || this.#socket.readyState !== 1) return;
    this.#timeline.append(frame);
    const bytes = new Uint8Array(frame.pcm.length * 2);
    const view = new DataView(bytes.buffer);
    frame.pcm.forEach((value, i) => view.setInt16(i * 2, value, true));
    this.#socket.send(bytes);
  }

  #drain() {
    clearTimeout(this.#drainTimer);
    if (this.#socket?.readyState !== 1) return;
    let sent = 0;
    while (this.#unsent.length && this.#socket.bufferedAmount < 512000 && sent++ < 100) {
      this.#send(this.#unsent.shift()!);
    }
    if (this.#unsent.length) this.#drainTimer = setTimeout(() => this.#drain(), 20);
    else if (this.#finishing) this.#endSocket();
  }

  write(frame: AudioFrame) {
    if (this.terminated || this.#finishing) return;
    this.checkFrame(frame);
    this.#lastAudio = Date.now();
    const copy = { ...frame, pcm: frame.pcm.slice() };
    this.#frames.push(copy);
    if (this.#socket?.readyState === 1) {
      this.#unsent.push(copy);
      this.#drain();
    }
  }

  finish(): Promise<void> {
    if (this.terminated) return Promise.resolve();
    if (this.#finish) return this.#finish;
    this.#finishing = true;
    this.#finish = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    this.#finishWatch = setTimeout(() => {
      this.emitError({
        code: 'connection',
        message:
          'STT finalization timed out. Some final transcript may be missing; local audio is retained when available.',
        fatal: false,
      });
      this.close();
    }, 15000);
    this.#endSocket();
    return this.#finish;
  }

  #endSocket() {
    if (this.#socket?.readyState !== 1 || this.#unsent.length || this.#endSent) return;
    this.#endSent = true;
    this.#socket.send(JSON.stringify({ type: 'CloseStream' }));
  }

  close() {
    if (this.terminated) return;
    ++this.#generation;
    clearTimeout(this.#watch);
    clearTimeout(this.#finishWatch);
    clearTimeout(this.#retry);
    clearInterval(this.#keepAlive);
    this.#detach();
    this.retractInterim();
    this.setStatus('closed');
    this.#frames = [];
    this.#resolve?.();
  }
}
