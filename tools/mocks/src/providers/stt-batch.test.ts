import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../app.ts';
import { startMocks, type RunningMocks } from '../server.ts';
import standupShort from '../../../../fixtures/audio/standup-short.segments.json' with { type: 'json' };
import { fixtureWords, sttProvider } from './stt.ts';

// Task 2.7: the pre-recorded (batch) `POST /stt/v1/listen` and the `/_mock/outage` switch.

interface BatchJson {
  metadata: { duration: number; request_id: string };
  results: {
    channels: {
      alternatives: {
        transcript: string;
        words: { word: string; start: number; end: number; punctuated_word?: string }[];
      }[];
    }[];
    utterances?: {
      start: number;
      end: number;
      transcript: string;
      words: { word: string; start: number; end: number; punctuated_word?: string }[];
    }[];
  };
}

const RATE = 16_000;

/** 16-bit PCM mono WAV of `ms` of audio; `speech` spans get a loud tone (the VAD's "speech"). */
function wav(ms: number, speech: { startMs: number; endMs: number }[] = []): Uint8Array {
  const n = Math.round((ms * RATE) / 1000);
  const out = new Uint8Array(44 + n * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, n * 2, true);
  for (const { startMs, endMs } of speech) {
    for (let i = Math.round((startMs * RATE) / 1000); i < Math.round((endMs * RATE) / 1000); i++) {
      view.setInt16(44 + i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), true);
    }
  }
  return out;
}

const batch = (
  query: string,
  body: Uint8Array,
  headers: Record<string, string> = { Authorization: 'Token dev', 'Content-Type': 'audio/wav' },
  app = createApp().app,
) => app.request(`/stt/v1/listen?${query}`, { method: 'POST', headers, body });

describe('stt mock: pre-recorded POST /v1/listen', () => {
  it('fixture mode returns the ground-truth words of the body’s span, on the body’s clock', async () => {
    const res = await batch(
      'model=nova-3&smart_format=true&utterances=true&mock_fixture=standup-short&mock_channel=mic&mock_offset_ms=5000',
      wav(10_000),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchJson;
    expect(json.metadata.duration).toBe(10);
    const expected = fixtureWords(standupShort, 'mic').filter(
      (w) => w.centerMs >= 5000 && w.centerMs < 15_000,
    );
    expect(expected.length).toBeGreaterThan(0);
    const words = json.results.channels[0]!.alternatives[0]!.words;
    expect(words.map((w) => w.punctuated_word)).toEqual(expected.map((w) => w.punctuated));
    expect(words[0]!.start).toBeCloseTo(Math.max(0, expected[0]!.startMs - 5000) / 1000, 2);
    // Utterances cover the same words, split at pauses ≥ 0.8 s.
    const utterances = json.results.utterances!;
    expect(utterances.flatMap((u) => u.words)).toEqual(words);
    for (let i = 1; i < utterances.length; i++) {
      expect(utterances[i]!.start - utterances[i - 1]!.end).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('corpus mode puts words on the speech the VAD hears; silence → no words', async () => {
    const speech = [
      { startMs: 1000, endMs: 3000 },
      { startMs: 6000, endMs: 7000 },
    ];
    const res = await batch('utterances=true&smart_format=true', wav(9000, speech));
    const json = (await res.json()) as BatchJson;
    const words = json.results.channels[0]!.alternatives[0]!.words;
    expect(words.length).toBe(5 + 2);
    for (const w of words) {
      const mid = ((w.start + w.end) / 2) * 1000;
      expect(speech.some((s) => mid >= s.startMs && mid <= s.endMs)).toBe(true);
    }
    expect(json.results.utterances).toHaveLength(2);
    expect(json.results.utterances![0]!.transcript).toBe('Let us start with a');

    const silent = (await (await batch('utterances=true', wav(4000))).json()) as BatchJson;
    expect(silent.results.channels[0]!.alternatives[0]!.words).toEqual([]);
    expect(silent.results.utterances).toEqual([]);
  });

  it('accepts raw linear16 with encoding + sample_rate; refuses what it can’t read', async () => {
    const raw = wav(2000, [{ startMs: 0, endMs: 2000 }]).subarray(44);
    const ok = await batch('encoding=linear16&sample_rate=16000', raw, {
      Authorization: 'Token dev',
      'Content-Type': 'application/octet-stream',
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as BatchJson).metadata.duration).toBe(2);
    const bad = await batch('', raw, { Authorization: 'Token dev' });
    expect(bad.status).toBe(400);
    const unknownFixture = await batch('mock_fixture=nope&mock_channel=mic', wav(1000));
    expect(unknownFixture.status).toBe(400);
  });

  it('auth: none → 401, unknown bearer → 401, granted bearer ok; acceptAnyBearer takes any', async () => {
    const { app } = createApp();
    expect((await batch('', wav(500), {}, app)).status).toBe(401);
    expect((await batch('', wav(500), { Authorization: 'Bearer forged' }, app)).status).toBe(401);
    const grant = (await (await app.request('/stt/v1/auth/grant', { method: 'POST' })).json()) as {
      access_token: string;
    };
    const granted = await batch(
      '',
      wav(500),
      { Authorization: `Bearer ${grant.access_token}` },
      app,
    );
    expect(granted.status).toBe(200);
    expect((await batch('reject_status=429', wav(500), undefined, app)).status).toBe(429);

    const lenient = createApp({ providers: [() => sttProvider({ acceptAnyBearer: true })] }).app;
    expect((await batch('', wav(500), { Authorization: 'Bearer forged' }, lenient)).status).toBe(
      200,
    );
  });
});

describe('stt mock: /_mock/outage', () => {
  let running: RunningMocks | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  const setDown = (m: RunningMocks, down: boolean) =>
    fetch(`${m.url}/stt/_mock/outage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ down }),
    });

  function open(m: RunningMocks): Promise<{ ws: WebSocket; status?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `${m.url.replace('http', 'ws')}/stt/v1/listen?encoding=linear16&sample_rate=16000`,
        { headers: { Authorization: 'Token dev' } },
      );
      ws.on('open', () => resolve({ ws }));
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve({ ws, status: res.statusCode });
      });
      ws.on('error', () => undefined);
    });
  }

  it('drops open sockets and answers 503 to handshakes and batch requests until it is back', async () => {
    running = await startMocks();
    const before = await open(running);
    expect(before.status).toBeUndefined();
    const closed = new Promise<number>((resolve) => before.ws.on('close', (code) => resolve(code)));

    expect(await (await setDown(running, true)).json()).toEqual({ down: true });
    expect(await closed).toBe(1006); // terminated, like a network drop
    expect((await open(running)).status).toBe(503);
    const refused = await fetch(`${running.url}/stt/v1/listen`, {
      method: 'POST',
      headers: { Authorization: 'Token dev', 'Content-Type': 'audio/wav' },
      body: wav(500),
    });
    expect(refused.status).toBe(503);

    await setDown(running, false);
    const after = await open(running);
    expect(after.status).toBeUndefined();
    after.ws.close();
    expect(
      (await fetch(`${running.url}/stt/_mock/outage`, { method: 'POST', body: '{}' })).status,
    ).toBe(400);
  });

  it('reset clears the outage', async () => {
    running = await startMocks();
    await setDown(running, true);
    await fetch(`${running.url}/_reset?provider=stt`, { method: 'POST' });
    const after = await open(running);
    expect(after.status).toBeUndefined();
    after.ws.close();
  });
});
