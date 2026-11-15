/**
 * `GET` / `PUT /api/profile` (4.6) with real Better Auth sessions (cookie + bearer) against a throwaway
 * database. The API has no user id: each caller only ever reads and writes their own profile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileDto } from '@/lib/profile';

import { BASE, call, createHarness, denies, type Harness, type TestUser } from './api/test-harness';
import { aiProfile, createProfileApi, type ProfileApi } from './profile';

let h: Harness;
let alice: TestUser;
let bob: TestUser;
let api: ProfileApi;

beforeAll(async () => {
  h = await createHarness();
  api = createProfileApi({
    db: () => h.db,
    getSession: (headers) => h.auth.api.getSession({ headers }),
    allowedOrigins: () => [BASE],
  });
  alice = await h.signUp('alice-profile');
  bob = await h.signUp('bob-profile');
}, 60_000);

afterAll(() => h?.close());

const ALICE = {
  name: 'Alice Liddell',
  role: 'Account executive',
  team: 'Sales EMEA',
  about: 'Pilots, pricing and security reviews.',
  vocabulary: ['Brightsmile', 'DentaCore', 'brightsmile'],
};

const get = (as: TestUser | null, options: { bearer?: boolean } = {}) =>
  call<ProfileDto>(api.profile.GET, 'GET', '/api/profile', { as, ...options });
const put = (as: TestUser | null, body: unknown, options: { origin?: string | null } = {}) =>
  call<ProfileDto>(api.profile.PUT, 'PUT', '/api/profile', { as, body, ...options });

describe('/api/profile', () => {
  it('starts empty, saves (normalised) and reads back my own profile', async () => {
    const empty = await get(alice);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      email: alice.email,
      role: '',
      team: '',
      about: '',
      vocabulary: [],
      updatedAt: null,
    });

    const saved = await put(alice, ALICE);
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    expect(saved.body).toMatchObject({ ...ALICE, vocabulary: ['Brightsmile', 'DentaCore'] });
    // The desktop (bearer) sees the same.
    expect((await get(alice, { bearer: true })).body).toEqual(saved.body);
    // The display name is the account's name (sidebar, sharing).
    const session = await h.auth.api.getSession({ headers: new Headers({ cookie: alice.cookie }) });
    expect(session?.user.name).toBe('Alice Liddell');

    expect(await aiProfile(h.db, alice.id)).toEqual({
      me: { name: 'Alice Liddell', email: alice.email },
      aboutMe:
        'Role: Account executive\nTeam: Sales EMEA\nWhat I care about:\nPilots, pricing and security reviews.',
      vocabulary: ['Brightsmile', 'DentaCore'],
    });
  });

  it('another user never sees or changes my profile', async () => {
    denies('GET /api/profile', 'PUT /api/profile');
    await put(alice, ALICE);
    const theirs = await get(bob);
    expect(theirs.status).toBe(200);
    expect(theirs.body.email).toBe(bob.email);
    expect(JSON.stringify(theirs.body)).not.toContain('Brightsmile');

    // There is no way to name another user: extra fields are refused, and Bob's write is Bob's.
    expect((await put(bob, { ...ALICE, userId: alice.id })).status).toBe(400);
    expect((await put(bob, { ...ALICE, email: alice.email })).status).toBe(400);
    const bobSaved = await put(bob, { ...ALICE, name: 'Bob', vocabulary: ['Mallory'] });
    expect(bobSaved.body.email).toBe(bob.email);
    expect((await get(alice)).body).toMatchObject({
      name: 'Alice Liddell',
      vocabulary: ALICE.vocabulary.slice(0, 2),
    });
    expect((await aiProfile(h.db, bob.id)).vocabulary).toEqual(['Mallory']);
  });

  it('needs a session and refuses cross-site writes', async () => {
    denies('GET /api/profile', 'PUT /api/profile');
    expect((await get(null)).status).toBe(401);
    expect((await put(null, ALICE)).status).toBe(401);
    expect(
      await put(alice, { ...ALICE, about: 'hacked' }, { origin: 'https://evil.test' }),
    ).toMatchObject({
      status: 403,
      error: { code: 'cross_site' },
    });
    expect((await get(alice)).body.about).not.toBe('hacked');
  });

  it('enforces the length limits', async () => {
    for (const body of [
      { ...ALICE, name: 'x'.repeat(101) },
      { ...ALICE, name: '' },
      { ...ALICE, name: '   ' },
      { ...ALICE, about: 'x'.repeat(1001) },
      { ...ALICE, vocabulary: Array.from({ length: 101 }, (_, i) => `t${i}`) },
      { ...ALICE, vocabulary: ['x'.repeat(61)] },
      { ...ALICE, role: 42 },
      { name: 'only a name' },
    ]) {
      const res = await put(alice, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });
});
