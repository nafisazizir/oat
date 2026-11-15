import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../app.ts';
import { startMocks, type RunningMocks } from '../server.ts';
import standupShort from '../../../../fixtures/audio/standup-short.segments.json' with { type: 'json' };
import { fixtureWords } from './stt.ts';

// Grant over app.request(); websockets against an in-process server (no containers: unit tests).

interface Results {
  type: 'Results';
  start: number;
  duration: number;
  is_final: boolean;
  speech_final: boolean;
  from_finalize: boolean;
  channel: {
    alternatives: {
      transcript: string;
      words: { word: string; start: number; end: number; punctuated_word?: string }[];
    }[];
  };
}
type ServerMessage = Results | { type: 'Metadata'; duration: number };

let running: RunningMocks | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function mocks(): Promise<RunningMocks> {
  running = await startMocks();
  return running;
}

const BASE_QUERY =
  'encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true';

interface Session {
  ws: WebSocket;
  messages: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
}

function connect(
  m: RunningMocks,
  query: string,
  headers: Record<string, string> = { Authorization: 'Token dev' },
  protocols?: string[],
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${m.url.replace('http', 'ws')}/stt/v1/listen?${query}`, protocols, {
      headers,
    });
    const messages: ServerMessage[] = [];
    const closed = new Promise<{ code: number; reason: string }>((done) =>
      ws.on('close', (code, reason) => done({ code, reason: reason.toString() })),
    );
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.on('error', reject);
  });
}

/** 16 kHz mono PCM: silence (tiny noise) and tone sections, in ms. */
function synth(parts: { ms: number; tone: boolean }[]): Buffer {
  const total = parts.reduce((n, p) => n + p.ms * 16, 0);
  const buf = Buffer.alloc(total * 2);
  let i = 0;
  for (const p of parts) {
    for (let k = 0; k < p.ms * 16; k++, i++) {
      const v = p.tone ? Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000)) : (i % 7) - 3;
      buf.writeInt16LE(v, i * 2);
    }
  }
  return buf;
}

function sendChunked(ws: WebSocket, pcm: Buffer, chunkMs = 100): void {
  const bytes = chunkMs * 32;
  for (let o = 0; o < pcm.length; o += bytes) ws.send(pcm.subarray(o, o + bytes));
}

async function wavChannel(name: string, channel: 0 | 1): Promise<Buffer> {
  const buf = await readFile(new URL(`../../../../fixtures/audio/${name}.wav`, import.meta.url));
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + size);
      const out = Buffer.alloc(data.length / 2);
      for (let i = 0; i < out.length / 2; i++) {
        out.writeInt16LE(data.readInt16LE((i * 2 + channel) * 2), i * 2);
      }
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

const results = (s: Session) => s.messages.filter((m): m is Results => m.type === 'Results');
const finals = (s: Session) => results(s).filter((r) => r.is_final);
const text = (rs: Results[]) =>
  rs
    .map((r) => r.channel.alternatives[0]!.transcript)
    .filter(Boolean)
    .join(' ');

async function closeStream(s: Session) {
  s.ws.send(JSON.stringify({ type: 'CloseStream' }));
  return s.closed;
}

describe('stt grant (POST /stt/v1/auth/grant)', () => {
  it('issues a short-lived token', async () => {
    const { app } = createApp();
    const res = await app.request('/stt/v1/auth/grant', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    expect(body.access_token).toMatch(/^mock-dg-/);
    expect(body.expires_in).toBe(30);
  });

  it('honours ttl_seconds and validates it', async () => {
    const { app } = createApp();
    const ok = await app.request('/stt/v1/auth/grant', {
      method: 'POST',
      body: JSON.stringify({ ttl_seconds: 120 }),
    });
    expect(await ok.json()).toMatchObject({ expires_in: 120 });
    const bad = await app.request('/stt/v1/auth/grant', {
      method: 'POST',
      body: JSON.stringify({ ttl_seconds: 0 }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects with reject_auth', async () => {
    const { app } = createApp();
    const res = await app.request('/stt/v1/auth/grant?reject_auth=1', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('stt listen handshake', () => {
  it('requires credentials and only accepts granted bearer tokens', async () => {
    const m = await mocks();
    await expect(connect(m, BASE_QUERY, {})).rejects.toMatchObject({ status: 401 });
    await expect(
      connect(m, BASE_QUERY, { Authorization: 'Bearer not-granted' }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(connect(m, `${BASE_QUERY}&reject_auth=1`)).rejects.toMatchObject({
      status: 401,
    });

    const grant = (await (
      await fetch(`${m.url}/stt/v1/auth/grant`, { method: 'POST' })
    ).json()) as { access_token: string };
    const viaHeader = await connect(m, BASE_QUERY, {
      Authorization: `Bearer ${grant.access_token}`,
    });
    viaHeader.ws.close();
    const viaProtocol = await connect(m, BASE_QUERY, {}, ['bearer', grant.access_token]);
    expect(viaProtocol.ws.protocol).toBe('bearer');
    viaProtocol.ws.close();

    const statuses = m.log.list({ provider: 'stt' }).map((r) => r.status);
    expect(statuses).toEqual([401, 401, 401, 200, 101, 101]);
    const logged = m.log.list({ provider: 'stt' }).at(-1)!;
    expect(logged.headers['sec-websocket-protocol']).toBe('bearer, [redacted]');
  });

  it('validates the query (400)', async () => {
    const m = await mocks();
    await expect(connect(m, 'encoding=opus&sample_rate=16000')).rejects.toMatchObject({
      status: 400,
    });
    await expect(connect(m, 'encoding=linear16')).rejects.toMatchObject({ status: 400 });
    await expect(
      connect(m, `${BASE_QUERY}&mock_fixture=nope&mock_channel=mic`),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('stt listen scenarios', () => {
  it('reject_status answers the handshake with that status (402/429)', async () => {
    const m = await mocks();
    await expect(connect(m, `${BASE_QUERY}&reject_status=402`)).rejects.toMatchObject({
      status: 402,
    });
    await expect(connect(m, `${BASE_QUERY}&reject_status=429`)).rejects.toMatchObject({
      status: 429,
    });
  });

  it('rejects an expired granted token', async () => {
    const m = await mocks();
    const grant = (await (
      await fetch(`${m.url}/stt/v1/auth/grant`, {
        method: 'POST',
        body: JSON.stringify({ ttl_seconds: 1 }),
      })
    ).json()) as { access_token: string };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2_000 });
    try {
      await expect(
        connect(m, BASE_QUERY, { Authorization: `Bearer ${grant.access_token}` }),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('endpointing=false: no speech_final at the end of speech; Finalize flushes', async () => {
    const s = await connect(
      await mocks(),
      `${BASE_QUERY.replace('interim_results=true', 'interim_results=false')}&endpointing=false`,
    );
    sendChunked(
      s.ws,
      synth([
        { ms: 1500, tone: true },
        { ms: 1000, tone: false },
      ]),
    );
    s.ws.send(JSON.stringify({ type: 'Finalize' }));
    await closeStream(s);
    const fs = finals(s).filter((r) => r.channel.alternatives[0]!.transcript);
    expect(fs[0]).toMatchObject({ from_finalize: true });
  });
});

describe('stt listen (corpus mode)', () => {
  it('emits interims while speech goes on, a speech_final after the endpoint, contiguous results', async () => {
    const s = await connect(await mocks(), `${BASE_QUERY}&endpointing=300`);
    sendChunked(
      s.ws,
      synth([
        { ms: 1000, tone: false },
        { ms: 2000, tone: true },
        { ms: 1000, tone: false },
      ]),
    );
    const closed = await closeStream(s);
    expect(closed.code).toBe(1000);

    const rs = results(s);
    const firstFinal = rs.findIndex((r) => r.is_final);
    expect(firstFinal).toBeGreaterThan(0);
    expect(rs.slice(0, firstFinal).every((r) => !r.is_final)).toBe(true);
    const f = rs[firstFinal]!;
    expect(f.speech_final).toBe(true);
    expect(f.channel.alternatives[0]!.transcript).toMatch(/^Let us start with/);
    const words = f.channel.alternatives[0]!.words;
    expect(words[0]!.start).toBeGreaterThanOrEqual(1);
    expect(words.at(-1)!.end).toBeLessThanOrEqual(3.1);
    // Finals tile the audio without gaps or overlap.
    const fs = finals(s);
    for (let i = 1; i < fs.length; i++) {
      expect(fs[i]!.start).toBeCloseTo(fs[i - 1]!.start + fs[i - 1]!.duration, 3);
    }
    expect(s.messages.at(-1)).toMatchObject({ type: 'Metadata', duration: 4 });
  });

  it('finalizes on Finalize with from_finalize', async () => {
    const s = await connect(await mocks(), BASE_QUERY);
    sendChunked(s.ws, synth([{ ms: 1500, tone: true }]));
    s.ws.send(JSON.stringify({ type: 'Finalize' }));
    await closeStream(s);
    expect(finals(s)[0]).toMatchObject({ from_finalize: true, is_final: true });
  });

  it('closes 1011 when idle and stays open with KeepAlive', async () => {
    const m = await mocks();
    const idle = await connect(m, `${BASE_QUERY}&mock_idle_timeout_ms=150`);
    expect((await idle.closed).code).toBe(1011);

    const kept = await connect(m, `${BASE_QUERY}&mock_idle_timeout_ms=150`);
    const timer = setInterval(() => kept.ws.send(JSON.stringify({ type: 'KeepAlive' })), 40);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(timer);
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);
    await closeStream(kept);
  });

  it('delays messages with latency_ms', async () => {
    const s = await connect(await mocks(), `${BASE_QUERY}&latency_ms=200`);
    const t0 = performance.now();
    sendChunked(s.ws, synth([{ ms: 1500, tone: true }]));
    await new Promise<void>((resolve) => s.ws.once('message', () => resolve()));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
    await closeStream(s);
  });

  it('drop_after_ms terminates the first connection only', async () => {
    const m = await mocks();
    const q = `${BASE_QUERY}&drop_after_ms=1000&mock_session=a`;
    const first = await connect(m, q);
    sendChunked(first.ws, synth([{ ms: 2000, tone: false }]));
    expect((await first.closed).code).toBe(1006);

    const second = await connect(m, `${q}&mock_offset_ms=900`);
    sendChunked(second.ws, synth([{ ms: 2000, tone: false }]));
    expect((await closeStream(second)).code).toBe(1000);
  });
});

describe('stt listen (fixture mode)', () => {
  it('transcribes a fixture channel to its ground truth, with word times on the socket clock', async () => {
    const s = await connect(
      await mocks(),
      `${BASE_QUERY}&mock_fixture=standup-short&mock_channel=mic&endpointing=300`,
    );
    sendChunked(s.ws, await wavChannel('standup-short', 0));
    await closeStream(s);

    const truth = standupShort.filter((x) => x.source === 'mic').map((x) => x.text);
    expect(text(finals(s))).toBe(truth.join(' '));
    expect(results(s).some((r) => !r.is_final)).toBe(true);
    const first = finals(s).find((r) => r.channel.alternatives[0]!.words.length)!;
    expect(first.channel.alternatives[0]!.words[0]).toMatchObject({
      word: 'morning',
      punctuated_word: 'Morning,',
      start: 0.5,
    });
  });

  it('maps fixture time through mock_offset_ms (reconnect replay)', async () => {
    const s = await connect(
      await mocks(),
      `${BASE_QUERY}&mock_fixture=standup-short&mock_channel=system&mock_offset_ms=16000`,
    );
    const system = await wavChannel('standup-short', 1);
    sendChunked(s.ws, system.subarray(16_000 * 32));
    await closeStream(s);
    const truth = standupShort.filter((x) => x.source === 'system' && x.startMs >= 16_000);
    expect(text(finals(s))).toBe(truth.map((x) => x.text).join(' '));
    const firstWord = finals(s).find((r) => r.channel.alternatives[0]!.words.length)!.channel
      .alternatives[0]!.words[0]!;
    expect(firstWord.start).toBeCloseTo((truth[0]!.startMs - 16_000) / 1000, 2);
  });

  it('spreads words over each segment', () => {
    const words = fixtureWords(standupShort, 'system');
    expect(words[0]).toMatchObject({ startMs: 8634, punctuated: 'Nice.' });
    const firstSeg = words.slice(0, 8);
    expect(firstSeg.at(-1)!.endMs).toBeCloseTo(11729, 6);
  });
});
