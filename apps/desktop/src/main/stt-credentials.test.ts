import { describe, expect, it, vi } from 'vitest';

import { checkListenUrl, SttCredentials, type SttGrant } from './stt-credentials.ts';

const grant = (n: number, overrides: Partial<SttGrant> = {}): SttGrant => ({
  accessToken: `tok-${n}`,
  expiresIn: 60,
  listenUrl: 'ws://localhost:14010/stt/v1/listen',
  ...overrides,
});

describe('SttCredentials', () => {
  it('reuses a token until shortly before it expires; refresh forces a new one', async () => {
    let now = 0;
    let n = 0;
    const fetchGrant = vi.fn(async () => grant(++n));
    const creds = new SttCredentials({ fetchGrant, now: () => now });
    expect(await creds.getToken()).toEqual({ token: 'tok-1', scheme: 'bearer' });
    now = 45_000;
    expect((await creds.getToken()).token).toBe('tok-1');
    now = 51_000; // within 10 s of expiry
    expect((await creds.getToken()).token).toBe('tok-2');
    expect((await creds.getToken({ refresh: true })).token).toBe('tok-3');
    expect(fetchGrant).toHaveBeenCalledTimes(3);
  });

  it('two streams connecting at once share one request', async () => {
    const fetchGrant = vi.fn(async () => grant(1));
    const creds = new SttCredentials({ fetchGrant });
    const [a, b, url] = await Promise.all([creds.getToken(), creds.getToken(), creds.listenUrl()]);
    expect(a).toEqual(b);
    expect(url).toBe('ws://localhost:14010/stt/v1/listen');
    expect(fetchGrant).toHaveBeenCalledTimes(1);
  });

  it('a failed request is not cached; the next call tries again', async () => {
    const fetchGrant = vi
      .fn<() => Promise<SttGrant>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(grant(2));
    const creds = new SttCredentials({ fetchGrant });
    await expect(creds.getToken()).rejects.toThrow('offline');
    expect((await creds.getToken()).token).toBe('tok-2');
  });

  it('refuses an insecure or odd listen URL from the API', async () => {
    const creds = new SttCredentials({
      fetchGrant: async () => grant(1, { listenUrl: 'ws://stt.example.com/v1/listen' }),
    });
    await expect(creds.getToken()).rejects.toThrow(/wss/);
  });

  it('clear() during a request: the late answer is not cached (sign-out)', async () => {
    let release!: (g: SttGrant) => void;
    let n = 0;
    const fetchGrant = vi.fn(() =>
      ++n === 1 ? new Promise<SttGrant>((r) => (release = r)) : Promise.resolve(grant(n)),
    );
    const creds = new SttCredentials({ fetchGrant });
    const pending = creds.getToken();
    creds.clear();
    release(grant(1));
    await pending;
    expect((await creds.getToken()).token).toBe('tok-2'); // asked again, not the stale token
    expect(fetchGrant).toHaveBeenCalledTimes(2);
  });

  it('clear() forgets the token', async () => {
    let n = 0;
    const creds = new SttCredentials({ fetchGrant: async () => grant(++n) });
    await creds.getToken();
    creds.clear();
    expect((await creds.getToken()).token).toBe('tok-2');
  });
});

describe('checkListenUrl', () => {
  it('wss anywhere, ws only on loopback, no credentials', () => {
    expect(checkListenUrl('wss://api.deepgram.com/v1/listen')).toBe(
      'wss://api.deepgram.com/v1/listen',
    );
    expect(checkListenUrl('ws://127.0.0.1:1/x')).toBe('ws://127.0.0.1:1/x');
    expect(() => checkListenUrl('ws://evil.example/x')).toThrow(/wss/);
    expect(() => checkListenUrl('https://api.deepgram.com/v1/listen')).toThrow(/wss/);
    expect(() => checkListenUrl('wss://u:p@api.deepgram.com/')).toThrow(/credentials/);
    expect(() => checkListenUrl('nope')).toThrow(/not a URL/);
  });
});
