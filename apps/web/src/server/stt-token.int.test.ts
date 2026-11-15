/**
 * `POST /api/stt/token` (2.5) with a real in-process Better Auth (bearer and cookie sessions, revoked
 * sessions) against the compose stack's Deepgram-compatible mock (`MOCKS_URL`, D-11).
 */
import { saveUserProfile } from '@oat/db';
import { testEnv } from '@oat/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SttTokenResponse } from '@/lib/api-types';

import { denies } from './api/authz-markers';
import { BASE, createHarness, type Harness, type TestUser } from './api/test-harness';
import { profileKeyterms } from './profile';
import { createSttTokenRoute } from './stt-token';

let h: Harness;
let user: TestUser;
let route: (request: Request) => Promise<Response>;
const mocks = testEnv.mocksUrl();

beforeAll(async () => {
  h = await createHarness();
  user = await h.signUp('stt');
  route = createSttTokenRoute({
    getSession: (headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
    env: () => ({ MOCKS_URL: mocks }),
    keyterms: (userId) => profileKeyterms(h.db, userId),
  });
}, 60_000);

afterAll(() => h?.close());

const post = (headers: Record<string, string>) =>
  route(new Request(`${BASE}/api/stt/token`, { method: 'POST', headers }));

describe('POST /api/stt/token', () => {
  it('desktop bearer session → a short-lived token the mock grant issued', async () => {
    const res = await post({ authorization: `Bearer ${user.bearer}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SttTokenResponse;
    expect(body.accessToken).toMatch(/^mock-dg-/);
    expect(body.expiresIn).toBe(60);
    expect(body.listenUrl).toBe(`${mocks.replace(/^http/, 'ws')}/stt/v1/listen`);
    expect(body.keyterms).toEqual([]);
  });

  it('offers my "About me" vocabulary as keyterms, never someone else’s (4.6)', async () => {
    await saveUserProfile(h.db, user.id, {
      name: 'Stt User',
      role: '',
      team: '',
      about: '',
      vocabulary: ['Brightsmile', 'DentaCore'],
    });
    const mine = (await (
      await post({ authorization: `Bearer ${user.bearer}` })
    ).json()) as SttTokenResponse;
    expect(mine.keyterms).toEqual(['Brightsmile', 'DentaCore']);
    const other = await h.signUp('stt-other');
    const theirs = (await (
      await post({ authorization: `Bearer ${other.bearer}` })
    ).json()) as SttTokenResponse;
    expect(theirs.keyterms).toEqual([]);
  });

  it('web cookie session from our origin works too', async () => {
    const res = await post({ cookie: user.cookie, origin: BASE });
    expect(res.status).toBe(200);
  });

  it('anonymous, forged bearer and cross-site cookie requests are refused', async () => {
    denies('POST /api/stt/token');
    expect((await post({ origin: BASE })).status).toBe(401);
    expect((await post({ authorization: 'Bearer not-a-real.token' })).status).toBe(401);
    expect((await post({ cookie: user.cookie, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('a revoked session gets no token', async () => {
    denies('POST /api/stt/token');
    const other = await h.signUp('stt-revoked');
    await h.auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${other.bearer}` }) });
    expect((await post({ authorization: `Bearer ${other.bearer}` })).status).toBe(401);
  });
});
