/**
 * Proves the schema works with Better Auth (D-9) + its organization plugin mapped onto workspace /
 * membership / invite (`auth-mapping.ts`). Better Auth's Drizzle adapter validates the schema at runtime
 * (missing tables/columns, required columns it doesn't write) and throws on the first query if it drifts.
 * Real wiring (magic link, Google, personal workspace on sign-up) is task 1.6.
 */
import { createTestDatabase, type TestDatabase } from '@oat/testkit';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizationOptions } from './auth-mapping.ts';
import { createDb, type Db, migrate } from './client.ts';
import { newId, UUID_V7 } from './id.ts';
import * as schema from './schema/index.ts';

let testDb: TestDatabase;
let db: Db;

function makeAuth(database: Db) {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'test-secret-test-secret-test-secret-0123',
    telemetry: { enabled: false },
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    advanced: { database: { generateId: () => newId() } },
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        ...organizationOptions,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization, user }) => ({
            data: { ...organization, createdBy: user.id },
          }),
        },
      }),
    ],
  });
}
let auth: ReturnType<typeof makeAuth>;

/** Signs up with email + password and returns request headers carrying the session cookie. */
async function signUp(email: string, name: string) {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: 'correct horse battery staple', name },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { user: response.user, headers: new Headers({ cookie }) };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.url);
  db = createDb(testDb.url, { max: 4 });
  auth = makeAuth(db);
});

afterAll(async () => {
  await db?.$client.end();
  await testDb?.drop();
});

describe('Better Auth on @oat/db', () => {
  it('signs up into user/account/session with our ids', async () => {
    const { user } = await signUp('ada@example.test', 'Ada');
    expect(user.id).toMatch(UUID_V7);
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, user.id));
    expect(row).toMatchObject({ email: 'ada@example.test', name: 'Ada', emailVerified: false });
    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, user.id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe('credential');
    const sessions = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, user.id));
    expect(sessions).toHaveLength(1);
  });

  it('creates workspaces, invites and memberships through the organization plugin', async () => {
    const owner = await signUp('owner@example.test', 'Owner');
    const org = await auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme' },
      headers: owner.headers,
    });
    expect(org?.id).toMatch(UUID_V7);

    const [ws] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, org!.id));
    expect(ws).toMatchObject({
      name: 'Acme',
      slug: 'acme',
      kind: 'team',
      createdBy: owner.user.id,
    });
    const owners = await db
      .select()
      .from(schema.membership)
      .where(eq(schema.membership.workspaceId, org!.id));
    expect(owners).toMatchObject([{ userId: owner.user.id, role: 'owner' }]);

    // `kind` is not client-settable (input: false); personal workspaces are created server-side (here via
    // the hook's data, in the app by @oat/auth) and Better Auth reads them back with their kind.
    const sneaky = await auth.api.createOrganization({
      // @ts-expect-error `kind` is not part of the create body (Better Auth drops it)
      body: { name: 'Sneaky', slug: `sneaky-${owner.user.id}`, kind: 'personal' },
      headers: owner.headers,
    });
    const [sneakyRow] = await db
      .select()
      .from(schema.workspace)
      .where(eq(schema.workspace.id, sneaky!.id));
    expect(sneakyRow?.kind).toBe('team');
    const [pws] = await db
      .insert(schema.workspace)
      .values({
        name: 'Owner',
        slug: `personal-${owner.user.id}`,
        kind: 'personal',
        createdBy: owner.user.id,
      })
      .returning();
    await db
      .insert(schema.membership)
      .values({ workspaceId: pws!.id, userId: owner.user.id, role: 'owner' });
    const personalFull = await auth.api.getFullOrganization({
      query: { organizationId: pws!.id },
      headers: owner.headers,
    });
    expect(personalFull?.kind).toBe('personal');
    // At most one personal workspace per creator (partial unique index).
    await expect(
      db.insert(schema.workspace).values({
        name: 'Owner 2',
        slug: `personal-2-${owner.user.id}`,
        kind: 'personal',
        createdBy: owner.user.id,
      }),
    ).rejects.toThrow();

    await auth.api.setActiveOrganization({
      body: { organizationId: org!.id },
      headers: owner.headers,
    });
    const [ownerSession] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, owner.user.id));
    expect(ownerSession?.activeWorkspaceId).toBe(org!.id);

    const invitation = await auth.api.createInvitation({
      body: { email: 'bob@example.test', role: 'member', organizationId: org!.id },
      headers: owner.headers,
    });
    const [inv] = await db.select().from(schema.invite).where(eq(schema.invite.id, invitation.id));
    expect(inv).toMatchObject({
      workspaceId: org!.id,
      email: 'bob@example.test',
      role: 'member',
      status: 'pending',
      inviterId: owner.user.id,
    });
    expect(inv?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const bob = await signUp('bob@example.test', 'Bob');
    // Accepting needs a verified email (magic-link sign-ups are verified; password ones here aren't).
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, bob.user.id));
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: bob.headers,
    });
    const [accepted] = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.id, invitation.id));
    expect(accepted?.status).toBe('accepted');
    const members = await db
      .select({ userId: schema.membership.userId, role: schema.membership.role })
      .from(schema.membership)
      .where(eq(schema.membership.workspaceId, org!.id));
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: owner.user.id, role: 'owner' },
        { userId: bob.user.id, role: 'member' },
      ]),
    );

    const full = await auth.api.getFullOrganization({
      query: { organizationId: org!.id },
      headers: owner.headers,
    });
    expect(full?.members).toHaveLength(2);

    // Better Auth writes reach the change log through the triggers (D-22).
    const logged = await db
      .select({ tableName: schema.changeLog.tableName, rowId: schema.changeLog.rowId })
      .from(schema.changeLog)
      .where(eq(schema.changeLog.workspaceId, org!.id));
    const loggedTables = new Set(logged.map((r) => r.tableName));
    expect([...loggedTables].sort()).toEqual(['invite', 'membership', 'workspace']);

    // Workspace hard-deletion through Better Auth is disabled (D-22).
    await expect(
      auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: owner.headers }),
    ).rejects.toThrow();
    const [still] = await db
      .select()
      .from(schema.workspace)
      .where(eq(schema.workspace.id, org!.id));
    expect(still?.id).toBe(org!.id);
  });
});
