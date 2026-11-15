/**
 * Deepgram pre-recorded ("batch") transcription (task 2.7): `POST /v1/listen` with a WAV body, the same
 * model/formatting as the live stream, `utterances=true` so the response comes back already split into
 * utterances (one segment each). Used to back-fill STT outages from the local Opus archive (D-17).
 *
 * Response subset used: `metadata.duration` (s), `results.utterances[] {start, end, transcript, confidence,
 * words[]}` and, when utterances are missing, `results.channels[0].alternatives[0].words[]` (grouped into
 * utterances here, split at pauses ≥ `UTTERANCE_GAP_MS`).
 */
import { encodeWav } from '@oat/audio';

import type { DeepgramWord } from './deepgram-results.ts';
import type { GetDeepgramToken } from './deepgram-config.ts';
import {
  SttBatchError,
  type SttBatchRequest,
  type SttBatchResult,
  type SttSegmentData,
  type SttWord,
} from './types.ts';

/** Words further apart than this start a new utterance when the response has no `utterances`. */
export const UTTERANCE_GAP_MS = 800;

export interface DeepgramBatchOptions {
  /** Live websocket URL of the same deployment (`…/v1/listen`); the batch endpoint is its http(s) twin. */
  listenUrl: string;
  getToken: GetDeepgramToken;
  model: string;
  smartFormat: boolean;
  mipOptOut: boolean;
  /** Per request. Default 120 000 (a 5-minute chunk uploads and transcribes well within it). */
  timeoutMs?: number;
  /** Handshake-style auth retries with a refreshed token. Default 1. */
  authRetries?: number;
  /** Dev/test-only extra query parameters (mock fixtures). */
  extraQuery?: Readonly<Record<string, string | number | boolean>>;
  fetch?: typeof fetch;
}

/** `wss://host/v1/listen` → `https://host/v1/listen` (Deepgram serves both on the same path). */
export function batchUrlFor(listenUrl: string): string {
  const url = new URL(listenUrl);
  url.protocol =
    url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  url.search = '';
  return url.toString();
}

export function buildBatchUrl(
  options: Pick<DeepgramBatchOptions, 'listenUrl' | 'model' | 'smartFormat' | 'mipOptOut'>,
  request: Pick<SttBatchRequest, 'language' | 'keyterms'>,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): string {
  const url = new URL(batchUrlFor(options.listenUrl));
  const q = url.searchParams;
  q.set('model', options.model);
  q.set('smart_format', String(options.smartFormat));
  q.set('punctuate', 'true');
  q.set('utterances', 'true');
  if (options.mipOptOut) q.set('mip_opt_out', 'true');
  if (request.language) q.set('language', request.language);
  for (const term of request.keyterms ?? []) q.append('keyterm', term);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return url.toString();
}

export async function transcribeDeepgram(
  options: DeepgramBatchOptions,
  request: SttBatchRequest,
): Promise<SttBatchResult> {
  if (!(request.sampleRate > 0)) throw new RangeError('sampleRate must be positive');
  const doFetch = options.fetch ?? fetch;
  const url = buildBatchUrl(options, request, options.extraQuery);
  // A fresh buffer (`Uint8Array<ArrayBuffer>`, what `fetch` bodies take in DOM typings).
  const body = encodeWav({
    sampleRate: request.sampleRate,
    channels: [request.pcm],
  }) as Uint8Array<ArrayBuffer>;
  const authRetries = options.authRetries ?? 1;
  for (let attempt = 0; ; attempt++) {
    let token;
    try {
      token = await options.getToken(attempt > 0 ? { refresh: true } : undefined);
    } catch (error) {
      throw new SttBatchError('token', `getToken failed: ${describe(error)}`, true);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `${token.scheme === 'token' ? 'Token' : 'Bearer'} ${token.token}`,
          'Content-Type': 'audio/wav',
        },
        body,
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw new SttBatchError('connection', `request failed: ${describe(error)}`, true);
    }
    if ((res.status === 401 || res.status === 403) && attempt < authRetries) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw httpError(res.status, detail.slice(0, 200));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SttBatchError('protocol', 'response is not JSON', true, res.status);
    }
    return mapBatchResponse(json, request.source, request.offsetMs ?? 0);
  }
}

function httpError(status: number, detail: string): SttBatchError {
  const message = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new SttBatchError('auth', message, false, status);
  if (status === 402) return new SttBatchError('quota', message, false, status);
  if (status === 429) return new SttBatchError('quota', message, true, status);
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return new SttBatchError('bad_request', message, false, status);
  }
  return new SttBatchError('connection', message, true, status);
}

interface BatchUtterance {
  start: number;
  end: number;
  transcript?: string;
  confidence?: number;
  words?: DeepgramWord[];
}

interface BatchResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: { alternatives?: { words?: DeepgramWord[] }[] }[];
    utterances?: BatchUtterance[];
  };
}

/** Deepgram pre-recorded response → final segments on the caller's clock (`offsetMs` + seconds × 1000). */
export function mapBatchResponse(
  json: unknown,
  source: SttSegmentData['source'],
  offsetMs: number,
): SttBatchResult {
  const r = json as BatchResponse | null;
  if (!r || typeof r !== 'object' || !r.results) {
    throw new SttBatchError('protocol', 'response has no results', true);
  }
  const at = (seconds: number) => Math.round(offsetMs + seconds * 1000);
  const toWord = (w: DeepgramWord): SttWord => ({
    word: w.word,
    ...(w.punctuated_word !== undefined ? { punctuatedWord: w.punctuated_word } : {}),
    startMs: at(w.start),
    endMs: at(w.end),
    ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
  });
  let groups: { words: SttWord[]; confidence?: number }[];
  if (Array.isArray(r.results.utterances)) {
    groups = r.results.utterances
      .filter((u) => typeof u.start === 'number' && typeof u.end === 'number')
      .map((u) => ({
        words: (u.words ?? []).filter(validWord).map(toWord),
        ...(u.confidence !== undefined ? { confidence: u.confidence } : {}),
      }));
  } else {
    const words = (r.results.channels?.[0]?.alternatives?.[0]?.words ?? [])
      .filter(validWord)
      .map(toWord);
    groups = [];
    for (const word of words) {
      const last = groups.at(-1)?.words.at(-1);
      if (!last || word.startMs - last.endMs >= UTTERANCE_GAP_MS) groups.push({ words: [word] });
      else groups.at(-1)!.words.push(word);
    }
  }
  const segments: SttSegmentData[] = groups
    .filter((g) => g.words.length > 0)
    .map((g) => ({
      source,
      startMs: g.words[0]!.startMs,
      endMs: Math.max(g.words[0]!.startMs, g.words.at(-1)!.endMs),
      text: g.words.map((w) => w.punctuatedWord ?? w.word).join(' '),
      isFinal: true,
      speechFinal: true,
      words: g.words,
      ...(g.confidence !== undefined ? { confidence: g.confidence } : {}),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  const duration = r.metadata?.duration;
  return {
    segments,
    durationMs: typeof duration === 'number' ? Math.round(duration * 1000) : 0,
  };
}

function validWord(w: DeepgramWord): boolean {
  return (
    !!w &&
    typeof w.word === 'string' &&
    typeof w.start === 'number' &&
    typeof w.end === 'number' &&
    w.end >= w.start
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
