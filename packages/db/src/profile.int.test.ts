import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, migrate } from './client.ts';
import { getUserProfile, saveUserProfile } from './profile.ts';
import * as s from './schema/index.ts';

let testDb: TestDatabase;
let db: Db;
let alice: string;
let bob: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  const users = await db
    .insert(s.user)
    .values([
      { email: 'alice@profile.test', name: 'Alice' },
      { email: 'bob@profile.test', name: null },
    ])
    .returning();
  [alice, bob] = users.map((u) => u.id) as [string, string];
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

describe('user profile', () => {
  it('reads empty fields before the first save', async () => {
    expect(await getUserProfile(db, bob)).toEqual({
      name: '',
      email: 'bob@profile.test',
      role: '',
      team: '',
      about: '',
      vocabulary: [],
      updatedAt: null,
    });
    expect(await getUserProfile(db, 'nobody')).toBeUndefined();
  });

  it('saves normalised fields and the display name, per user', async () => {
    const saved = await saveUserProfile(db, alice, {
      name: '  Alice   Liddell ',
      role: 'Account executive',
      team: ' Sales  EMEA',
      about: 'Pilots.\r\n\r\n\r\n\r\nPricing.  ',
      vocabulary: ['DentaCore', ' dentacore ', '', 'Brightsmile'],
    });
    expect(saved).toMatchObject({
      name: 'Alice Liddell',
      role: 'Account executive',
      team: 'Sales EMEA',
      about: 'Pilots.\n\nPricing.',
      vocabulary: ['DentaCore', 'Brightsmile'],
    });
    expect(saved.updatedAt).not.toBeNull();
    const [row] = await db.select().from(s.user).where(eq(s.user.id, alice));
    expect(row!.name).toBe('Alice Liddell');
    // Bob's profile is untouched.
    expect((await getUserProfile(db, bob))!.role).toBe('');

    // Saving again updates in place.
    const again = await saveUserProfile(db, alice, { ...saved, vocabulary: [] });
    expect(again.vocabulary).toEqual([]);
    expect(await db.select().from(s.userProfile)).toHaveLength(1);
  });

  it('requires a name (blank after trimming is refused, nothing written)', async () => {
    for (const name of ['', '   ']) {
      await expect(
        saveUserProfile(db, bob, { name, role: 'x', team: '', about: '', vocabulary: [] }),
      ).rejects.toThrow(RangeError);
    }
    expect((await getUserProfile(db, bob))!.role).toBe('');
  });

  it('refuses over-long values at the database too', async () => {
    await expect(
      db.insert(s.userProfile).values({ userId: bob, about: 'x'.repeat(1001) }),
    ).rejects.toThrow();
  });
});
