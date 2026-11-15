import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { WebSocket, type RawData } from 'ws';
import oneOnOne from '../../../../fixtures/audio/one-on-one.segments.json' with { type: 'json' };
import silenceGap from '../../../../fixtures/audio/silence-gap.segments.json' with { type: 'json' };
import standupShort from '../../../../fixtures/audio/standup-short.segments.json' with { type: 'json' };
import type { MockProvider, MockUpgradeRejection } from '../provider.ts';

/**
 * Deepgram-compatible live transcription (subset), mounted at `/stt`:
 *
 * - `POST /stt/v1/auth/grant` → `{ access_token, expires_in }`: short-lived token (D-17). Body
 *   `{ ttl_seconds }` optional (1–3600, default 30). Any (or no) API key is accepted in dev.
 * - `WS /stt/v1/listen?encoding=linear16&sample_rate=16000&…`: binary linear16 mono audio in, JSON `Results`
 *   out (`is_final`, `speech_final`, `start`, `duration`, `channel.alternatives[0].{transcript,words}`),
 *   `KeepAlive` / `Finalize` / `CloseStream` text messages, `Metadata` + close 1000 after `CloseStream`,
 *   close 1011 after `mock_idle_timeout_ms` (default 10 s) without audio or a text message. Auth: header
 *   `Authorization: Token <any>` or `Bearer <granted token>`, or the `token`/`bearer` subprotocol pair.
 *
 * Transcripts: an energy VAD finds speech in the audio; while speech goes on, interim results arrive every
 * 500 ms of audio; a final is emitted once `endpointing` ms of silence follow (`speech_final`; with
 * `endpointing=false` the speech region still ends after 300 ms but nothing is finalized then), after 8 s of
 * continuous speech, after 3 s of silence (empty transcript, keeps results contiguous like Deepgram), and
 * on `Finalize`/`CloseStream`; with `interim_results`, an (often empty) interim every 1 s of silence.
 * Words come from a deterministic sentence corpus, timed at the speech; or, with the dev-only
 * `mock_fixture=<name>&mock_channel=mic|system`, from that fixture's ground truth
 * (`fixtures/audio/<name>.segments.json`) by time, so tests can assert the exact text. Production code
 * never sends `mock_*` params.
 *
 * Scenario params (dev/test only): `mock_offset_ms` (recording time of the first audio sample on this
 * socket, for fixture lookups after a reconnect), `drop_after_ms` (terminate the socket abruptly once that
 * much audio arrived; only the first `drop_times`, default 1, connections with the same params are
 * dropped — add `mock_session=<id>` to tell otherwise identical streams apart), `latency_ms` (delay every
 * server message), `reject_auth=1` (401 on the handshake and on grant), `reject_status=<4xx/5xx>` (that
 * HTTP status on the handshake, e.g. 402 or 429), `mock_idle_timeout_ms`.
 */

/** RMS above this (≈ −40 dBFS) counts as speech. Fixture noise floor is ≈ 10, speech is in the thousands. */
const SPEECH_RMS = 300;
const WINDOW_MS = 20;
const INTERIM_EVERY_MS = 500;
const MAX_CHUNK_MS = 8_000;
const SILENCE_FINAL_MS = 3_000;
/** Interim results (usually empty) during silence, so a flowing stream never looks stalled. */
const SILENCE_INTERIM_MS = 1_000;
const DEFAULT_ENDPOINTING_MS = 300;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
/** Corpus mode: one word every this many ms of speech. */
const CORPUS_WORD_MS = 400;
const DEFAULT_TOKEN_TTL_S = 30;

interface GroundTruthSegment {
  source: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** Fixture ground truth bundled into the mock (also in the container image, see Dockerfile). */
const FIXTURES: Record<string, GroundTruthSegment[]> = {
  'one-on-one': oneOnOne,
  'silence-gap': silenceGap,
  'standup-short': standupShort,
};

/** Our own filler sentences for corpus mode (no fixture). Deterministic: every socket starts at sentence 0. */
const CORPUS = [
  'Let us start with a quick update on the project.',
  'The new build went out yesterday and looks stable so far.',
  'We still need to agree on the timeline for the next release.',
  'I can take the action item to follow up with the design team.',
  'Does anyone have questions before we move on?',
  'The numbers from last week are better than we expected.',
  'Let us pick this up again on Thursday.',
];
const CORPUS_TOKENS = CORPUS.join(' ').split(/\s+/);

interface MockWord {
  /** Recording-clock ms (socket ms + offset). */
  startMs: number;
  endMs: number;
  centerMs: number;
  punctuated: string;
}

/** Spread a segment's words over its time span, weighted by token length. */
export function fixtureWords(segments: readonly GroundTruthSegment[], channel: string): MockWord[] {
  const words: MockWord[] = [];
  for (const seg of segments
    .filter((s) => s.source === channel)
    .sort((a, b) => a.startMs - b.startMs)) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const weights = tokens.map((t) => t.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = seg.startMs;
    tokens.forEach((token, i) => {
      const len = ((seg.endMs - seg.startMs) * weights[i]!) / total;
      words.push({ startMs: t, endMs: t + len, centerMs: t + len / 2, punctuated: token });
      t += len;
    });
  }
  return words;
}

function bareWord(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

function parseAuth(request: IncomingMessage): { scheme: 'token' | 'bearer'; value: string } | null {
  const header = request.headers.authorization;
  const match = header?.match(/^\s*(token|bearer)\s+(\S+)\s*$/i);
  if (match) return { scheme: match[1]!.toLowerCase() as 'token' | 'bearer', value: match[2]! };
  const protocols = (request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim());
  const scheme = protocols[0]?.toLowerCase();
  if ((scheme === 'token' || scheme === 'bearer') && protocols[1]) {
    return { scheme, value: protocols[1] };
  }
  return null;
}

const truthy = (v: string | null) => v !== null && v !== 'false' && v !== '0';

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

interface ListenConfig {
  sampleRate: number;
  interim: boolean;
  smartFormat: boolean;
  /** Silence that ends a speech region. */
  endpointingMs: number;
  /** `endpointing=false`: no `speech_final` finalization at the end of a region. */
  endpointingOff: boolean;
  model: string;
  fixtureWords?: MockWord[];
  offsetMs: number;
  latencyMs: number;
  dropAfterMs?: number;
  idleTimeoutMs: number;
}

function badRequest(message: string): MockUpgradeRejection {
  return { status: 400, body: { err_code: 'Bad Request', err_msg: message } };
}

/** Validates the listen query; returns the config or a 400. */
function parseListenQuery(url: URL): ListenConfig | MockUpgradeRejection {
  const q = url.searchParams;
  const encoding = q.get('encoding');
  if (encoding !== 'linear16') return badRequest('mock supports encoding=linear16 only');
  const sampleRate = numberParam(url, 'sample_rate');
  if (sampleRate === undefined || !Number.isInteger(sampleRate) || sampleRate < 8000) {
    return badRequest('sample_rate is required for linear16 (integer ≥ 8000)');
  }
  const channels = numberParam(url, 'channels');
  if (channels !== undefined && channels !== 1) return badRequest('mock supports channels=1 only');

  const endpointingRaw = q.get('endpointing');
  const endpointing =
    endpointingRaw === null || endpointingRaw === 'false' || endpointingRaw === ''
      ? DEFAULT_ENDPOINTING_MS
      : Number(endpointingRaw);
  if (!Number.isFinite(endpointing) || endpointing < 0) {
    return badRequest('endpointing must be a number of ms or false');
  }

  let words: MockWord[] | undefined;
  const fixture = q.get('mock_fixture');
  if (fixture !== null) {
    const segments = FIXTURES[fixture];
    const channel = q.get('mock_channel');
    if (!segments) return badRequest(`unknown mock_fixture "${fixture}"`);
    if (channel !== 'mic' && channel !== 'system') {
      return badRequest('mock_channel must be mic or system');
    }
    words = fixtureWords(segments, channel);
  }

  const nums: Record<string, number | undefined> = {};
  for (const name of ['mock_offset_ms', 'latency_ms', 'drop_after_ms', 'mock_idle_timeout_ms']) {
    const n = numberParam(url, name);
    if (Number.isNaN(n) || (n !== undefined && n < 0)) return badRequest(`${name} must be ≥ 0`);
    nums[name] = n;
  }

  return {
    sampleRate,
    interim: truthy(q.get('interim_results')),
    smartFormat: truthy(q.get('smart_format')),
    // Our VAD works on 20 ms windows; very short endpointing would split every word.
    endpointingMs: Math.max(100, endpointing),
    endpointingOff: endpointingRaw === 'false',
    model: q.get('model') ?? 'base',
    fixtureWords: words,
    offsetMs: nums.mock_offset_ms ?? 0,
    latencyMs: nums.latency_ms ?? 0,
    dropAfterMs: nums.drop_after_ms,
    idleTimeoutMs: nums.mock_idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
  };
}

/** One `/v1/listen` socket. Audio time on this socket starts at 0 (Deepgram semantics). */
class ListenSession {
  readonly #socket: WebSocket;
  readonly #config: ListenConfig;
  readonly #shouldDrop: () => boolean;
  readonly #requestId = randomUUID();
  readonly #windowSamples: number;

  #remainder: Buffer = Buffer.alloc(0);
  #samples = 0; // processed
  #inSpeech = false;
  #silenceMs = 0;
  #finalizedUntilMs = 0;
  #lastInterimMs = 0;
  #closing = false;
  #idleTimer: NodeJS.Timeout | undefined;

  /** Words not yet finalized, in time order (fixture: precomputed; corpus: appended while speech goes on). */
  #words: MockWord[] = [];
  #corpusIndex = 0;
  #corpusNextCenterMs = 0;
  #speechStartMs = 0;
  #wordsInRegion = 0;

  constructor(socket: WebSocket, config: ListenConfig, shouldDrop: () => boolean) {
    this.#socket = socket;
    this.#config = config;
    this.#shouldDrop = shouldDrop;
    this.#windowSamples = Math.round((config.sampleRate * WINDOW_MS) / 1000);
    if (config.fixtureWords) {
      // Words before this socket's first sample were handled by an earlier connection.
      this.#words = config.fixtureWords.filter((w) => w.centerMs >= config.offsetMs);
    }
    socket.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    socket.on('close', () => clearTimeout(this.#idleTimer));
    socket.on('error', () => undefined);
    this.#touch();
  }

  get #cursorMs(): number {
    return (this.#samples / this.#config.sampleRate) * 1000;
  }

  #touch(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#closing = true;
      this.#later(() =>
        this.#socket.close(1011, 'NET-0001: no audio or KeepAlive within the timeout window'),
      );
    }, this.#config.idleTimeoutMs);
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#closing) return;
    this.#touch();
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (isBinary) {
      this.#onAudio(bytes);
      return;
    }
    let message: { type?: unknown };
    try {
      message = JSON.parse(bytes.toString('utf8')) as { type?: unknown };
    } catch {
      return; // Deepgram ignores text it can't parse; so do we.
    }
    if (message.type === 'Finalize') this.#finalize(true, true);
    else if (message.type === 'CloseStream') this.#closeStream();
    // KeepAlive only resets the idle timer (done above).
  }

  #onAudio(bytes: Buffer): void {
    let buf = this.#remainder.length ? Buffer.concat([this.#remainder, bytes]) : bytes;
    const windowBytes = this.#windowSamples * 2;
    let offset = 0;
    while (buf.length - offset >= windowBytes) {
      let sum = 0;
      for (let i = 0; i < this.#windowSamples; i++) {
        const v = buf.readInt16LE(offset + i * 2);
        sum += v * v;
      }
      offset += windowBytes;
      this.#samples += this.#windowSamples;
      this.#onWindow(Math.sqrt(sum / this.#windowSamples) > SPEECH_RMS);
      if (this.#closing) return;
    }
    buf = buf.subarray(offset);
    this.#remainder = Buffer.from(buf);
  }

  #onWindow(speech: boolean): void {
    const now = this.#cursorMs;
    if (speech) {
      if (!this.#inSpeech) {
        this.#inSpeech = true;
        this.#speechStartMs = now - WINDOW_MS;
        this.#wordsInRegion = 0;
        this.#corpusNextCenterMs = this.#speechStartMs + CORPUS_WORD_MS / 2;
      }
      this.#silenceMs = 0;
    } else if (this.#inSpeech) {
      this.#silenceMs += WINDOW_MS;
    }

    if (!this.#config.fixtureWords && this.#inSpeech) {
      while (this.#corpusNextCenterMs <= now - this.#silenceMs) {
        this.#addCorpusWord(this.#corpusNextCenterMs);
        this.#corpusNextCenterMs += CORPUS_WORD_MS;
      }
    }

    if (this.#inSpeech && this.#silenceMs >= this.#config.endpointingMs) {
      this.#inSpeech = false;
      if (!this.#config.fixtureWords && this.#wordsInRegion === 0) {
        this.#addCorpusWord((this.#speechStartMs + now - this.#silenceMs) / 2);
      }
      // Without endpointing the words wait for the next periodic/silence/Finalize final.
      if (!this.#config.endpointingOff) this.#finalize(true);
    } else if (this.#inSpeech && now - this.#finalizedUntilMs >= MAX_CHUNK_MS) {
      this.#finalize(false);
    } else if (!this.#inSpeech && now - this.#finalizedUntilMs >= SILENCE_FINAL_MS) {
      this.#finalize(false);
    } else if (
      this.#config.interim &&
      this.#inSpeech &&
      now - this.#lastInterimMs >= INTERIM_EVERY_MS
    ) {
      this.#lastInterimMs = now;
      const words = this.#wordsUpTo(now);
      if (words.length > 0) this.#sendResults(words, false, false, false);
    } else if (
      this.#config.interim &&
      !this.#inSpeech &&
      now - this.#lastInterimMs >= SILENCE_INTERIM_MS
    ) {
      // Like Deepgram, keep talking while audio flows: (usually empty) interims during silence.
      this.#lastInterimMs = now;
      this.#sendResults(this.#wordsUpTo(now), false, false, false);
    }

    if (
      this.#config.dropAfterMs !== undefined &&
      now >= this.#config.dropAfterMs &&
      this.#shouldDrop()
    ) {
      this.#closing = true;
      this.#socket.terminate();
    }
  }

  #addCorpusWord(socketCenterMs: number): void {
    const token = CORPUS_TOKENS[this.#corpusIndex++ % CORPUS_TOKENS.length]!;
    const center = socketCenterMs + this.#config.offsetMs;
    const half = CORPUS_WORD_MS * 0.4;
    this.#words.push({
      startMs: center - half,
      endMs: center + half,
      centerMs: center,
      punctuated: token,
    });
    this.#wordsInRegion++;
  }

  /** Pending words whose centre has been heard. */
  #wordsUpTo(socketMs: number): MockWord[] {
    const limit = socketMs + this.#config.offsetMs;
    let n = 0;
    while (n < this.#words.length && this.#words[n]!.centerMs <= limit) n++;
    return this.#words.slice(0, n);
  }

  #finalize(speechFinal: boolean, fromFinalize = false): void {
    const now = this.#cursorMs;
    const words = this.#wordsUpTo(now);
    if (now <= this.#finalizedUntilMs && words.length === 0) return;
    this.#sendResults(words, true, speechFinal, fromFinalize);
    this.#words = this.#words.slice(words.length);
    this.#finalizedUntilMs = now;
    this.#lastInterimMs = now;
  }

  #sendResults(
    words: MockWord[],
    isFinal: boolean,
    speechFinal: boolean,
    fromFinalize: boolean,
  ): void {
    const startMs = this.#finalizedUntilMs;
    const endMs = Math.max(startMs, this.#cursorMs);
    const toSocketS = (recMs: number) =>
      Math.round(Math.max(0, recMs - this.#config.offsetMs)) / 1000;
    const outWords = words.map((w, i) => ({
      word: bareWord(w.punctuated),
      start: toSocketS(w.startMs),
      end: toSocketS(w.endMs),
      confidence: 0.9 + ((i * 7) % 10) / 100,
      ...(this.#config.smartFormat ? { punctuated_word: w.punctuated } : {}),
    }));
    const transcript = (
      this.#config.smartFormat ? words.map((w) => w.punctuated) : outWords.map((w) => w.word)
    ).join(' ');
    this.#send({
      type: 'Results',
      channel_index: [0, 1],
      duration: Math.round(endMs - startMs) / 1000,
      start: Math.round(startMs) / 1000,
      is_final: isFinal,
      speech_final: speechFinal,
      from_finalize: fromFinalize,
      channel: {
        alternatives: [{ transcript, confidence: words.length ? 0.95 : 0, words: outWords }],
      },
      metadata: {
        request_id: this.#requestId,
        model_info: { name: `mock-${this.#config.model}`, version: 'mock', arch: 'mock' },
        model_uuid: '00000000-0000-4000-8000-000000000000',
      },
    });
  }

  #closeStream(): void {
    // Flush a trailing partial window as if it were complete audio.
    if (this.#remainder.length >= 2) {
      this.#samples += Math.floor(this.#remainder.length / 2);
      this.#remainder = Buffer.alloc(0);
    }
    this.#inSpeech = false;
    this.#finalize(true);
    this.#closing = true;
    this.#send({
      type: 'Metadata',
      transaction_key: 'deprecated',
      request_id: this.#requestId,
      sha256: '',
      created: new Date().toISOString(),
      duration: Math.round(this.#cursorMs) / 1000,
      channels: 1,
      models: ['00000000-0000-4000-8000-000000000000'],
    });
    this.#later(() => this.#socket.close(1000));
  }

  #send(message: unknown): void {
    const json = JSON.stringify(message);
    this.#later(() => {
      if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(json);
    });
  }

  /** Runs now, or after `latency_ms` (timers with equal delay fire in order, so ordering holds). */
  #later(fn: () => void): void {
    if (this.#config.latencyMs > 0) setTimeout(fn, this.#config.latencyMs);
    else fn();
  }
}

export function sttProvider(): MockProvider {
  /** Granted token → expiry (epoch ms). */
  const tokens = new Map<string, number>();
  /** Drop scenario key → how many connections were dropped. */
  const drops = new Map<string, number>();
  const app = new Hono();

  app.post('/v1/auth/grant', async (c) => {
    if (truthy(c.req.query('reject_auth') ?? null)) {
      return c.json(
        { err_code: 'INVALID_AUTH', err_msg: 'mock: auth rejected (reject_auth)' },
        401,
      );
    }
    let ttl = DEFAULT_TOKEN_TTL_S;
    const text = await c.req.text();
    if (text.trim() !== '') {
      let body: { ttl_seconds?: unknown };
      try {
        body = JSON.parse(text) as { ttl_seconds?: unknown };
      } catch {
        return c.json({ err_code: 'Bad Request', err_msg: 'body must be JSON' }, 400);
      }
      if (body.ttl_seconds !== undefined) {
        const n = Number(body.ttl_seconds);
        if (!Number.isFinite(n) || n < 1 || n > 3600) {
          return c.json({ err_code: 'Bad Request', err_msg: 'ttl_seconds must be 1–3600' }, 400);
        }
        ttl = n;
      }
    }
    const token = `mock-dg-${randomUUID()}`;
    const t = Date.now();
    for (const [old, expires] of tokens) if (expires < t) tokens.delete(old);
    tokens.set(token, t + ttl * 1000);
    return c.json({ access_token: token, expires_in: ttl });
  });

  const unauthorized = (message: string): MockUpgradeRejection => ({
    status: 401,
    body: { err_code: 'INVALID_AUTH', err_msg: message },
  });

  return {
    name: 'stt',
    description: 'Deepgram-compatible live transcription (WS /stt/v1/listen) + token grant.',
    app,
    websockets: [
      {
        path: '/v1/listen',
        verify(request, url) {
          if (truthy(url.searchParams.get('reject_auth'))) {
            return unauthorized('mock: auth rejected (reject_auth)');
          }
          const rejectStatus = Number(url.searchParams.get('reject_status'));
          if (Number.isInteger(rejectStatus) && rejectStatus >= 400 && rejectStatus <= 599) {
            return {
              status: rejectStatus,
              body: { err_code: 'MOCK_REJECTED', err_msg: `mock: reject_status=${rejectStatus}` },
            };
          }
          const auth = parseAuth(request);
          if (!auth) return unauthorized('missing credentials');
          if (auth.scheme === 'bearer') {
            const expires = tokens.get(auth.value);
            if (expires === undefined) return unauthorized('unknown token');
            if (expires < Date.now()) return unauthorized('token expired');
          }
          const config = parseListenQuery(url);
          return 'status' in config ? config : undefined;
        },
        handle(socket, _request, url) {
          const config = parseListenQuery(url) as ListenConfig;
          const key = [...url.searchParams]
            .filter(([k]) => k !== 'mock_offset_ms')
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('&');
          const dropTimesRaw = Number(url.searchParams.get('drop_times') ?? 1);
          const dropTimes = Number.isFinite(dropTimesRaw) ? dropTimesRaw : 1;
          new ListenSession(socket, config, () => {
            const done = drops.get(key) ?? 0;
            if (done >= dropTimes) return false;
            drops.set(key, done + 1);
            return true;
          });
        },
      },
    ],
    reset: () => {
      tokens.clear();
      drops.clear();
    },
  };
}
