import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  assertCan,
  assertCanMoveDocument,
  assertCanMoveFolder,
  canChangeRole,
  canCreateInWorkspace,
  canDeleteDocument,
  canDeleteFolder,
  canDeleteWorkspace,
  isLastWorkspace,
  canEditDocument,
  canEditFolder,
  canInvite,
  canCreateInFolder,
  canManageMembers,
  canMoveDocument,
  canMoveFolder,
  canSetFolderVisibility,
  decideMoveDocument,
  decideMoveFolder,
  canReadDocument,
  canReadFolder,
  canRemoveMember,
  canShareDocument,
  createPermissionContext,
  ForbiddenError,
  isForbiddenError,
  permissions,
  roleAtLeast,
  roleIn,
  shouldRotateShareToken,
  visibilityForNewItem,
  type DocumentAccess,
  type FolderAccess,
  type MemberTarget,
  type PermissionContext,
  type WorkspaceAccess,
} from './permissions.ts';
import {
  ROLES,
  type Document,
  type DocumentVisibility,
  type FolderVisibility,
  type Role,
} from './types.ts';

// -------------------------------------------------------------------------------------------------------
// Fixtures
//
// Workspace T: alice=owner, adam=admin, mia=member, vic=viewer. Olly owns another workspace B.
// Alice also owns S, a workspace of her own (so T isn't her last one); adam, mia and vic belong to T only.
// Documents/folders under test live in T and are owned by mia unless a case says otherwise, so "others' docs" cases are about owner/admin/viewer acting on mia's resources.
// -------------------------------------------------------------------------------------------------------

const T = 'ws-team';
const B = 'ws-other';
const S = 'ws-solo';
const TOKEN = 'Zx3_k9-QpL2mN8vR4tY6wA'; // 22 base64url chars (MIN_SHARE_TOKEN_LENGTH)

const TEAM: WorkspaceAccess = { id: T };
const OTHER: WorkspaceAccess = { id: B };
const SOLO: WorkspaceAccess = { id: S };

function ctx(userId: string | null, roles: Record<string, Role> = {}, shareToken?: string) {
  return createPermissionContext({
    userId,
    memberships: Object.entries(roles).map(([workspaceId, role]) => ({
      workspaceId,
      userId: userId ?? '',
      role,
    })),
    ...(shareToken === undefined ? {} : { shareToken }),
  });
}

const alice = ctx('alice', { [T]: 'owner', [S]: 'owner' });
/** The same people, also members of B: T is not their last workspace, so they may leave it. */
const adamInTwo = ctx('adam', { [T]: 'admin', [B]: 'member' });
const miaInTwo = ctx('mia', { [T]: 'member', [B]: 'viewer' });
const vicInTwo = ctx('vic', { [T]: 'viewer', [B]: 'viewer' });
/** Owns T and nothing else. */
const aliceOnlyT = ctx('alice', { [T]: 'owner' });
const adam = ctx('adam', { [T]: 'admin' });
const mia = ctx('mia', { [T]: 'member' });
const vic = ctx('vic', { [T]: 'viewer' });
const olly = ctx('olly', { [B]: 'owner' }); // owner elsewhere: cross-workspace spoofing attempts
const ollyWithToken = ctx('olly', { [B]: 'owner' }, TOKEN);
const miaRemoved = ctx('mia'); // mia after being removed from T
const anon = ctx(null);
const anonWithToken = ctx(null, {}, TOKEN);
const anonWrongToken = ctx(null, {}, 'tok_wrong00000');
/** Malformed context: anonymous but carrying memberships. Must not grant anything. */
const anonSpoofed: PermissionContext = { userId: null, memberships: new Map([[T, 'owner']]) };

const DELETED = new Date('2026-11-01T00:00:00Z');

function doc(overrides: Partial<DocumentAccess> = {}): DocumentAccess {
  return {
    workspaceId: T,
    ownerId: 'mia',
    visibility: 'workspace',
    shareToken: null,
    deletedAt: null,
    ...overrides,
  };
}

const priv = doc({ visibility: 'private' });
const wsDoc = doc({ visibility: 'workspace' });
const wsDocOldToken = doc({ visibility: 'workspace', shareToken: TOKEN }); // link turned off, token kept
const linkDoc = doc({ visibility: 'link', shareToken: TOKEN });
const vicPriv = doc({ visibility: 'private', ownerId: 'vic' });
const vicWs = doc({ visibility: 'workspace', ownerId: 'vic' });
const trashedWs = doc({ visibility: 'workspace', deletedAt: DELETED });
const trashedPriv = doc({ visibility: 'private', deletedAt: DELETED });
const trashedLink = doc({ visibility: 'link', shareToken: TOKEN, deletedAt: DELETED });
const vicTrashed = doc({ ownerId: 'vic', deletedAt: DELETED });
const otherWsDoc = doc({ workspaceId: B, ownerId: 'olly' });

function folder(overrides: Partial<FolderAccess> = {}): FolderAccess {
  return { workspaceId: T, ownerId: 'mia', visibility: 'workspace', ...overrides };
}
const privFolder = folder({ visibility: 'private' });
const wsFolder = folder({ visibility: 'workspace' });
const vicFolder = folder({ ownerId: 'vic', visibility: 'private' });

function member(userId: string, role: Role, ownerCount = 1, workspaceId = T): MemberTarget {
  return { workspaceId, userId, role, ownerCount };
}

type Case<R> = [label: string, ctx: PermissionContext, resource: R, expected: boolean];

// -------------------------------------------------------------------------------------------------------
// Documents
// -------------------------------------------------------------------------------------------------------

describe('canReadDocument', () => {
  it.each<Case<DocumentAccess>>([
    // owner of the document
    ['owner reads own private doc', mia, priv, true],
    ['viewer reads own private doc', vic, vicPriv, true],
    ['removed member cannot read own private doc', miaRemoved, priv, false],
    ['removed member cannot read own workspace doc', miaRemoved, wsDoc, false],
    // private: only the doc owner
    ['workspace owner cannot read others’ private doc', alice, priv, false],
    ['admin cannot read others’ private doc', adam, priv, false],
    ['viewer cannot read others’ private doc', vic, priv, false],
    [
      'token holder cannot read private doc',
      anonWithToken,
      doc({ visibility: 'private', shareToken: TOKEN }),
      false,
    ],
    // workspace
    ['owner reads workspace doc', alice, wsDoc, true],
    ['admin reads workspace doc', adam, wsDoc, true],
    ['viewer reads workspace doc', vic, wsDoc, true],
    ['non-member (member elsewhere) cannot read workspace doc', olly, wsDoc, false],
    ['anonymous cannot read workspace doc', anon, wsDoc, false],
    ['anonymous context with spoofed memberships cannot read', anonSpoofed, wsDoc, false],
    ['stale token does not open a workspace doc', anonWithToken, wsDocOldToken, false],
    ['member of T cannot read a B doc', alice, otherWsDoc, false],
    ['member of B reads a B doc', olly, otherWsDoc, true],
    // link
    ['member reads link doc without token', vic, linkDoc, true],
    ['anonymous with matching token reads link doc', anonWithToken, linkDoc, true],
    ['non-member with matching token reads link doc', ollyWithToken, linkDoc, true],
    ['anonymous without token cannot read link doc', anon, linkDoc, false],
    ['anonymous with wrong token cannot read link doc', anonWrongToken, linkDoc, false],
    ['token prefix does not match', ctx(null, {}, TOKEN.slice(0, 5)), linkDoc, false],
    ['token with extra suffix does not match', ctx(null, {}, `${TOKEN}x`), linkDoc, false],
    ['empty presented token does not match', ctx(null, {}, ''), linkDoc, false],
    [
      'link doc without a token is not readable by token',
      anonWithToken,
      doc({ visibility: 'link' }),
      false,
    ],
    [
      'empty stored token never matches',
      ctx(null, {}, ''),
      doc({ visibility: 'link', shareToken: '' }),
      false,
    ],
    [
      'stored token below 22 chars never matches, even exactly',
      ctx(null, {}, TOKEN.slice(0, 21)),
      doc({ visibility: 'link', shareToken: TOKEN.slice(0, 21) }),
      false,
    ],
    // soft-deleted
    ['owner reads own trashed doc', mia, trashedWs, true],
    ['viewer-owner reads own trashed doc', vic, vicTrashed, true],
    ['workspace owner reads trashed workspace doc', alice, trashedWs, true],
    ['admin reads trashed workspace doc', adam, trashedWs, true],
    ['admin reads trashed link doc', adam, trashedLink, true],
    ['member cannot read others’ trashed doc', ctx('max', { [T]: 'member' }), trashedWs, false],
    ['viewer cannot read trashed doc', vic, trashedWs, false],
    ['admin cannot read others’ trashed private doc', adam, trashedPriv, false],
    ['owner reads own trashed private doc', mia, trashedPriv, true],
    ['token holder cannot read trashed link doc', anonWithToken, trashedLink, false],
    ['removed member cannot read own trashed doc', miaRemoved, trashedWs, false],
  ])('%s', (_label, c, d, expected) => {
    expect(canReadDocument(c, d)).toBe(expected);
  });
});

describe('canEditDocument', () => {
  it.each<Case<DocumentAccess>>([
    ['owner edits own private doc', mia, priv, true],
    ['owner edits own workspace doc', mia, wsDoc, true],
    ['member edits others’ workspace doc', ctx('max', { [T]: 'member' }), wsDoc, true],
    ['member edits others’ link doc', ctx('max', { [T]: 'member' }), linkDoc, true],
    ['admin edits workspace doc', adam, wsDoc, true],
    ['workspace owner edits link doc', alice, linkDoc, true],
    ['admin cannot edit others’ private doc', adam, priv, false],
    ['workspace owner cannot edit others’ private doc', alice, priv, false],
    ['viewer cannot edit workspace doc', vic, wsDoc, false],
    ['viewer cannot edit own private doc', vic, vicPriv, false],
    ['viewer cannot edit own workspace doc', vic, vicWs, false],
    ['token holder cannot edit link doc', anonWithToken, linkDoc, false],
    ['non-member with token cannot edit link doc', ollyWithToken, linkDoc, false],
    ['anonymous cannot edit', anon, wsDoc, false],
    ['anonymous context with spoofed memberships cannot edit', anonSpoofed, wsDoc, false],
    ['non-member cannot edit workspace doc', olly, wsDoc, false],
    ['removed member cannot edit own doc', miaRemoved, priv, false],
    ['owner cannot edit trashed doc (restore first)', mia, trashedWs, false],
    ['admin cannot edit trashed doc', adam, trashedWs, false],
  ])('%s', (_label, c, d, expected) => {
    expect(canEditDocument(c, d)).toBe(expected);
  });
});

describe('canDeleteDocument', () => {
  it.each<Case<DocumentAccess>>([
    ['owner deletes own private doc', mia, priv, true],
    ['owner restores own trashed doc', mia, trashedWs, true],
    ['owner restores own trashed private doc', mia, trashedPriv, true],
    ['admin deletes others’ workspace doc', adam, wsDoc, true],
    ['workspace owner deletes others’ link doc', alice, linkDoc, true],
    ['admin restores others’ trashed workspace doc', adam, trashedWs, true],
    ['member cannot delete others’ workspace doc', ctx('max', { [T]: 'member' }), wsDoc, false],
    ['admin cannot delete others’ private doc', adam, priv, false],
    ['admin cannot restore others’ trashed private doc', adam, trashedPriv, false],
    ['viewer cannot delete own doc', vic, vicWs, false],
    ['viewer cannot delete others’ doc', vic, wsDoc, false],
    ['token holder cannot delete link doc', anonWithToken, linkDoc, false],
    ['anonymous cannot delete', anon, wsDoc, false],
    ['non-member cannot delete', olly, wsDoc, false],
    ['removed member cannot delete own doc', miaRemoved, priv, false],
  ])('%s', (_label, c, d, expected) => {
    expect(canDeleteDocument(c, d)).toBe(expected);
  });
});

describe('canShareDocument', () => {
  it.each<Case<DocumentAccess>>([
    ['owner shares own private doc', mia, priv, true],
    ['owner changes own link doc', mia, linkDoc, true],
    ['admin changes visibility of others’ workspace doc', adam, wsDoc, true],
    ['workspace owner rotates others’ link', alice, linkDoc, true],
    ['member cannot share others’ workspace doc', ctx('max', { [T]: 'member' }), wsDoc, false],
    ['admin cannot share others’ private doc', adam, priv, false],
    ['viewer cannot share own doc', vic, vicPriv, false],
    ['viewer cannot share others’ doc', vic, wsDoc, false],
    ['token holder cannot reshare', anonWithToken, linkDoc, false],
    ['anonymous cannot share', anon, wsDoc, false],
    ['non-member cannot share', olly, wsDoc, false],
    ['removed member cannot share own doc', miaRemoved, priv, false],
    ['owner cannot share trashed doc', mia, trashedWs, false],
    ['admin cannot share trashed doc', adam, trashedLink, false],
  ])('%s', (_label, c, d, expected) => {
    expect(canShareDocument(c, d)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------------------
// Folders
// -------------------------------------------------------------------------------------------------------

describe('canReadFolder', () => {
  it.each<Case<FolderAccess>>([
    ['owner reads own private folder', mia, privFolder, true],
    ['viewer reads own private folder', vic, vicFolder, true],
    ['member reads workspace folder', ctx('max', { [T]: 'member' }), wsFolder, true],
    ['viewer reads workspace folder', vic, wsFolder, true],
    ['admin cannot see others’ private folder', adam, privFolder, false],
    ['workspace owner cannot see others’ private folder', alice, privFolder, false],
    ['non-member cannot read workspace folder', olly, wsFolder, false],
    ['anonymous cannot read folder', anon, wsFolder, false],
    ['anonymous with a token cannot read folder', anonWithToken, wsFolder, false],
    ['removed member cannot read own folder', miaRemoved, privFolder, false],
  ])('%s', (_label, c, f, expected) => {
    expect(canReadFolder(c, f)).toBe(expected);
  });
});

describe('canEditFolder', () => {
  it.each<Case<FolderAccess>>([
    ['owner edits own private folder', mia, privFolder, true],
    ['member edits workspace folder', ctx('max', { [T]: 'member' }), wsFolder, true],
    ['admin edits workspace folder', adam, wsFolder, true],
    ['admin cannot edit others’ private folder', adam, privFolder, false],
    ['viewer cannot edit own folder', vic, vicFolder, false],
    ['viewer cannot edit workspace folder', vic, wsFolder, false],
    ['non-member cannot edit folder', olly, wsFolder, false],
    ['anonymous cannot edit folder', anon, wsFolder, false],
    ['removed member cannot edit own folder', miaRemoved, privFolder, false],
  ])('%s', (_label, c, f, expected) => {
    expect(canEditFolder(c, f)).toBe(expected);
  });
});

describe('canDeleteFolder', () => {
  it.each<Case<FolderAccess>>([
    ['owner deletes own private folder', mia, privFolder, true],
    ['admin deletes others’ workspace folder', adam, wsFolder, true],
    ['workspace owner deletes others’ workspace folder', alice, wsFolder, true],
    [
      'member cannot delete others’ workspace folder',
      ctx('max', { [T]: 'member' }),
      wsFolder,
      false,
    ],
    ['admin cannot delete others’ private folder', adam, privFolder, false],
    ['viewer cannot delete own folder', vic, vicFolder, false],
    ['non-member cannot delete folder', olly, wsFolder, false],
    ['anonymous cannot delete folder', anon, wsFolder, false],
  ])('%s', (_label, c, f, expected) => {
    expect(canDeleteFolder(c, f)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------------------
// Moves, creating in folders, folder visibility (D-18)
// -------------------------------------------------------------------------------------------------------

const ALLOWED = { allowed: true };
const MAKE_PRIVATE = { allowed: true, setVisibility: 'private' };
const DENIED = { allowed: false };

const adamPrivFolder = folder({ ownerId: 'adam', visibility: 'private' });
const miaPrivFolder2 = folder({ ownerId: 'mia', visibility: 'private' });
const otherWsFolder = folder({ workspaceId: B, ownerId: 'olly' });
const aliceSoloFolder = folder({ workspaceId: S, ownerId: 'alice', visibility: 'private' });
const aliceTeamDoc = doc({ ownerId: 'alice' });
const max = ctx('max', { [T]: 'member' });

type DocMoveCase = [string, PermissionContext, DocumentAccess, FolderAccess | null, object];

describe('decideMoveDocument / canMoveDocument', () => {
  it.each<DocMoveCase>([
    ['owner moves own doc to root', mia, wsDoc, null, ALLOWED],
    ['owner moves own doc into a workspace folder', mia, wsDoc, wsFolder, ALLOWED],
    ['member moves others’ workspace doc into a workspace folder', max, wsDoc, wsFolder, ALLOWED],
    ['admin moves others’ link doc to root', adam, linkDoc, null, ALLOWED],
    ['owner files own workspace doc into own private folder', mia, wsDoc, privFolder, MAKE_PRIVATE],
    ['owner files own link doc into own private folder', mia, linkDoc, privFolder, MAKE_PRIVATE],
    ['owner files own private doc into own private folder', mia, priv, privFolder, ALLOWED],
    ['owner moves own private doc to root (stays private)', mia, priv, null, ALLOWED],
    ['cannot file own doc into someone else’s private folder', mia, wsDoc, adamPrivFolder, DENIED],
    ['admin cannot file others’ doc into own private folder', adam, wsDoc, adamPrivFolder, DENIED],
    [
      'member cannot file others’ doc into its owner’s private folder',
      max,
      wsDoc,
      privFolder,
      DENIED,
    ],
    [
      'workspace owner cannot file others’ doc into a private folder',
      alice,
      wsDoc,
      privFolder,
      DENIED,
    ],
    ['admin cannot move others’ private doc', adam, priv, null, DENIED],
    ['viewer cannot move own doc', vic, vicWs, null, DENIED],
    ['viewer cannot file own doc into own private folder', vic, vicPriv, vicFolder, DENIED],
    ['viewer cannot move others’ doc', vic, wsDoc, wsFolder, DENIED],
    ['no cross-workspace move into another workspace’s folder', mia, wsDoc, otherWsFolder, DENIED],
    [
      'no cross-workspace move even as member of both',
      alice,
      aliceTeamDoc,
      aliceSoloFolder,
      DENIED,
    ],
    ['trashed doc cannot be moved', mia, trashedWs, null, DENIED],
    ['removed member cannot move own doc', miaRemoved, wsDoc, null, DENIED],
    ['non-member cannot move', olly, wsDoc, null, DENIED],
    ['token holder cannot move', anonWithToken, linkDoc, null, DENIED],
    ['anonymous cannot move', anon, wsDoc, wsFolder, DENIED],
    ['spoofed anonymous context cannot move', anonSpoofed, wsDoc, null, DENIED],
  ])('%s', (_label, c, d, target, expected) => {
    expect(decideMoveDocument(c, d, target)).toEqual(expected);
    // The boolean form is a real boolean (never a truthy object) and agrees with the decision.
    expect(canMoveDocument(c, d, target)).toBe((expected as { allowed: boolean }).allowed);
  });
});

type FolderMoveCase = [
  string,
  PermissionContext,
  FolderAccess,
  FolderAccess | null,
  string[],
  object,
];

describe('decideMoveFolder / canMoveFolder', () => {
  it.each<FolderMoveCase>([
    ['owner moves own private folder to root', mia, privFolder, null, [], ALLOWED],
    [
      'owner nests own private folder in another own private folder',
      mia,
      privFolder,
      miaPrivFolder2,
      ['mia'],
      ALLOWED,
    ],
    [
      'owner nests own empty workspace folder in own private folder',
      mia,
      wsFolder,
      miaPrivFolder2,
      [],
      MAKE_PRIVATE,
    ],
    [
      'owner nests own workspace folder holding only own items',
      mia,
      wsFolder,
      miaPrivFolder2,
      ['mia', 'mia'],
      MAKE_PRIVATE,
    ],
    [
      'cannot hide a workspace folder holding a teammate’s doc',
      mia,
      wsFolder,
      miaPrivFolder2,
      ['mia', 'max'],
      DENIED,
    ],
    [
      'cannot hide a workspace folder holding only teammates’ items',
      mia,
      wsFolder,
      miaPrivFolder2,
      ['adam'],
      DENIED,
    ],
    [
      'others’ items don’t block moves into workspace targets',
      max,
      wsFolder,
      wsFolder,
      ['adam', 'vic'],
      ALLOWED,
    ],
    ['others’ items don’t block moves to root', mia, wsFolder, null, ['adam'], ALLOWED],
    ['member cannot move others’ private folder', max, privFolder, null, [], DENIED],
    ['admin cannot move others’ private folder', adam, privFolder, null, [], DENIED],
    [
      'admin cannot nest others’ folder in own private folder',
      adam,
      wsFolder,
      adamPrivFolder,
      [],
      DENIED,
    ],
    [
      'cannot nest own folder in someone else’s private folder',
      mia,
      wsFolder,
      adamPrivFolder,
      [],
      DENIED,
    ],
    ['viewer cannot move own folder', vic, vicFolder, null, [], DENIED],
    ['no cross-workspace folder move', mia, wsFolder, otherWsFolder, [], DENIED],
    ['non-member cannot move folder', olly, wsFolder, null, [], DENIED],
    ['anonymous cannot move folder', anon, wsFolder, null, [], DENIED],
  ])('%s', (_label, c, f, target, contained, expected) => {
    expect(decideMoveFolder(c, f, target, contained)).toEqual(expected);
    expect(canMoveFolder(c, f, target, contained)).toBe((expected as { allowed: boolean }).allowed);
  });
});

describe('move asserts', () => {
  it('return the decision so the caller can apply setVisibility', () => {
    expect(assertCanMoveDocument(mia, wsDoc, privFolder)).toEqual(MAKE_PRIVATE);
    expect(assertCanMoveDocument(mia, wsDoc, null)).toEqual(ALLOWED);
    expect(assertCanMoveFolder(mia, wsFolder, miaPrivFolder2, ['mia'])).toEqual(MAKE_PRIVATE);
  });

  it('throw ForbiddenError naming the move', () => {
    expect(() => assertCanMoveDocument(adam, wsDoc, adamPrivFolder)).toThrow(
      'Forbidden: moveDocument',
    );
    expect(() => assertCanMoveFolder(mia, wsFolder, miaPrivFolder2, ['max'])).toThrow(
      'Forbidden: moveFolder',
    );
    expect(() => assertCanMoveFolder(anon, wsFolder, null, [])).toThrow(ForbiddenError);
  });

  it('boolean move checks also work through assertCan', () => {
    expect(() => assertCan('moveDocument', mia, wsDoc, privFolder)).not.toThrow();
    expect(() => assertCan('moveFolder', mia, wsFolder, miaPrivFolder2, ['max'])).toThrow(
      'Forbidden: moveFolder',
    );
  });
});

describe('canCreateInFolder / visibilityForNewItem', () => {
  it.each<Case<FolderAccess>>([
    ['owner creates in own private folder', mia, privFolder, true],
    ['member creates in workspace folder', max, wsFolder, true],
    ['admin cannot create in others’ private folder', adam, privFolder, false],
    ['workspace owner cannot create in others’ private folder', alice, privFolder, false],
    ['viewer cannot create in own private folder', vic, vicFolder, false],
    ['viewer cannot create in workspace folder', vic, wsFolder, false],
    ['non-member cannot create in folder', olly, wsFolder, false],
    ['anonymous cannot create in folder', anon, wsFolder, false],
  ])('%s', (_label, c, f, expected) => {
    expect(canCreateInFolder(c, f)).toBe(expected);
  });

  it.each<[string, FolderAccess | null, DocumentVisibility, DocumentVisibility]>([
    ['private folder forces private (workspace requested)', privFolder, 'workspace', 'private'],
    ['private folder forces private (link requested)', privFolder, 'link', 'private'],
    ['workspace folder keeps workspace', wsFolder, 'workspace', 'workspace'],
    ['workspace folder keeps private', wsFolder, 'private', 'private'],
    ['root keeps link', null, 'link', 'link'],
  ])('%s', (_label, f, requested, expected) => {
    expect(visibilityForNewItem(f, requested)).toBe(expected);
  });
});

describe('canSetFolderVisibility', () => {
  it.each<[string, PermissionContext, FolderAccess, FolderVisibility, string[], boolean]>([
    ['owner makes own empty workspace folder private', mia, wsFolder, 'private', [], true],
    [
      'owner makes own workspace folder of own items private',
      mia,
      wsFolder,
      'private',
      ['mia'],
      true,
    ],
    [
      'owner cannot make folder private while it holds a teammate’s doc',
      mia,
      wsFolder,
      'private',
      ['mia', 'max'],
      false,
    ],
    [
      'member cannot make others’ workspace folder private',
      max,
      wsFolder,
      'private',
      ['max'],
      false,
    ],
    ['admin cannot make others’ workspace folder private', adam, wsFolder, 'private', [], false],
    ['owner opens own private folder to workspace', mia, privFolder, 'workspace', ['mia'], true],
    ['private → private is a no-op for the owner', mia, privFolder, 'private', ['mia'], true],
    [
      'member keeps others’ workspace folder workspace (no-op)',
      max,
      wsFolder,
      'workspace',
      ['adam'],
      true,
    ],
    ['admin cannot open others’ private folder', adam, privFolder, 'workspace', [], false],
    ['viewer cannot change own folder', vic, vicFolder, 'workspace', [], false],
    ['non-member cannot change folder visibility', olly, wsFolder, 'private', [], false],
    ['anonymous cannot change folder visibility', anon, wsFolder, 'private', [], false],
  ])('%s', (_label, c, f, to, contained, expected) => {
    expect(canSetFolderVisibility(c, f, to, contained)).toBe(expected);
  });
});

describe('shouldRotateShareToken', () => {
  it.each<[DocumentVisibility, DocumentVisibility, boolean]>([
    ['private', 'link', true],
    ['workspace', 'link', true],
    ['link', 'link', false],
    ['link', 'workspace', false],
    ['link', 'private', false],
    ['private', 'workspace', false],
    ['workspace', 'private', false],
  ])('%s → %s: %s', (from, to, expected) => {
    expect(shouldRotateShareToken(from, to)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------------------
// Workspaces and members
// -------------------------------------------------------------------------------------------------------

describe('canCreateInWorkspace', () => {
  it.each<Case<WorkspaceAccess>>([
    ['owner creates', alice, TEAM, true],
    ['admin creates', adam, TEAM, true],
    ['member creates', mia, TEAM, true],
    ['owner creates in a workspace of one', alice, SOLO, true],
    ['viewer cannot create', vic, TEAM, false],
    ['non-member cannot create', olly, TEAM, false],
    ['member of T cannot create in B', alice, OTHER, false],
    ['anonymous cannot create', anon, TEAM, false],
    ['anonymous context with spoofed memberships cannot create', anonSpoofed, TEAM, false],
  ])('%s', (_label, c, w, expected) => {
    expect(canCreateInWorkspace(c, w)).toBe(expected);
  });
});

describe('canManageMembers', () => {
  it.each<Case<WorkspaceAccess>>([
    ['owner manages team members', alice, TEAM, true],
    ['admin manages team members', adam, TEAM, true],
    ['member cannot manage members', mia, TEAM, false],
    ['viewer cannot manage members', vic, TEAM, false],
    ['owner manages members of a workspace of one (D-36)', alice, SOLO, true],
    ['owner of B cannot manage T', olly, TEAM, false],
    ['anonymous cannot manage members', anon, TEAM, false],
  ])('%s', (_label, c, w, expected) => {
    expect(canManageMembers(c, w)).toBe(expected);
  });
});

describe('canInvite', () => {
  // Rows: actor role in T. Columns: invited role, in ROLES order (owner, admin, member, viewer).
  const matrix: Record<Role, [boolean, boolean, boolean, boolean]> = {
    owner: [true, true, true, true],
    admin: [false, true, true, true],
    member: [false, false, false, false],
    viewer: [false, false, false, false],
  };
  const cases = ROLES.flatMap((actor) =>
    ROLES.map((invited, i) => [actor, invited, matrix[actor][i]] as const),
  );

  it.each(cases)('%s inviting %s → %s', (actor, invited, expected) => {
    expect(canInvite(ctx('actor', { [T]: actor }), TEAM, invited)).toBe(expected);
  });

  it.each(ROLES)('the owner of a workspace of one can invite anyone (%s, D-36)', (invited) => {
    expect(canInvite(alice, SOLO, invited)).toBe(true);
  });

  it('denies anonymous and non-members', () => {
    expect(canInvite(anon, TEAM, 'viewer')).toBe(false);
    expect(canInvite(olly, TEAM, 'viewer')).toBe(false);
  });
});

describe('canChangeRole', () => {
  it.each<[string, PermissionContext, WorkspaceAccess, MemberTarget, Role, boolean]>([
    ['owner promotes member to admin', alice, TEAM, member('mia', 'member'), 'admin', true],
    ['owner promotes member to owner', alice, TEAM, member('mia', 'member'), 'owner', true],
    [
      'owner demotes another owner when two exist',
      alice,
      TEAM,
      member('bob', 'owner', 2),
      'admin',
      true,
    ],
    [
      'owner demotes self when another owner exists',
      alice,
      TEAM,
      member('alice', 'owner', 2),
      'member',
      true,
    ],
    ['last owner cannot be demoted', alice, TEAM, member('alice', 'owner', 1), 'admin', false],
    [
      'last owner may be “changed” to owner (no-op)',
      alice,
      TEAM,
      member('alice', 'owner', 1),
      'owner',
      true,
    ],
    ['admin promotes member to admin', adam, TEAM, member('mia', 'member'), 'admin', true],
    ['admin cannot demote another admin', adam, TEAM, member('ada', 'admin'), 'viewer', false],
    ['owner demotes an admin', alice, TEAM, member('adam', 'admin'), 'member', true],
    ['admin cannot change own admin role', adam, TEAM, member('adam', 'admin'), 'member', false],
    ['admin demotes member to viewer', adam, TEAM, member('mia', 'member'), 'viewer', true],
    ['admin cannot promote to owner', adam, TEAM, member('mia', 'member'), 'owner', false],
    ['admin cannot demote an owner', adam, TEAM, member('alice', 'owner', 2), 'member', false],
    ['member cannot change roles', mia, TEAM, member('vic', 'viewer'), 'member', false],
    ['viewer cannot change roles', vic, TEAM, member('vic', 'viewer'), 'member', false],
    [
      'the only owner of a workspace of one cannot demote themselves',
      alice,
      SOLO,
      member('alice', 'owner', 1, S),
      'admin',
      false,
    ],
    [
      'target from another workspace is rejected',
      alice,
      TEAM,
      member('olly', 'owner', 1, B),
      'viewer',
      false,
    ],
    ['owner of B cannot change roles in T', olly, TEAM, member('mia', 'member'), 'viewer', false],
    ['anonymous cannot change roles', anon, TEAM, member('mia', 'member'), 'viewer', false],
  ])('%s', (_label, c, w, target, newRole, expected) => {
    expect(canChangeRole(c, w, target, newRole)).toBe(expected);
  });
});

describe('canRemoveMember', () => {
  it.each<[string, PermissionContext, WorkspaceAccess, MemberTarget, boolean]>([
    ['owner removes member', alice, TEAM, member('mia', 'member'), true],
    ['owner removes another owner when two exist', alice, TEAM, member('bob', 'owner', 2), true],
    [
      'owner cannot remove the last owner',
      ctx('bob', { [T]: 'owner' }),
      TEAM,
      member('alice', 'owner', 1),
      false,
    ],
    ['admin removes member', adam, TEAM, member('mia', 'member'), true],
    ['admin removes viewer', adam, TEAM, member('vic', 'viewer'), true],
    ['admin cannot remove another admin', adam, TEAM, member('ada', 'admin'), false],
    ['owner removes an admin', alice, TEAM, member('adam', 'admin'), true],
    ['admin can leave', adamInTwo, TEAM, member('adam', 'admin'), true],
    ['admin cannot remove an owner', adam, TEAM, member('alice', 'owner', 2), false],
    ['member cannot remove others', mia, TEAM, member('vic', 'viewer'), false],
    ['viewer cannot remove others', vic, TEAM, member('mia', 'member'), false],
    ['viewer can leave', vicInTwo, TEAM, member('vic', 'viewer'), true],
    ['member can leave', miaInTwo, TEAM, member('mia', 'member'), true],
    ['owner can leave when another owner exists', alice, TEAM, member('alice', 'owner', 2), true],
    ['last owner cannot leave', alice, TEAM, member('alice', 'owner', 1), false],
    // D-36: nobody leaves their last workspace, whatever their role.
    ['admin cannot leave their only workspace', adam, TEAM, member('adam', 'admin'), false],
    ['member cannot leave their only workspace', mia, TEAM, member('mia', 'member'), false],
    ['viewer cannot leave their only workspace', vic, TEAM, member('vic', 'viewer'), false],
    [
      'owner cannot leave their only workspace, even with another owner',
      aliceOnlyT,
      TEAM,
      member('alice', 'owner', 2),
      false,
    ],
    // …but removing someone else is not leaving: the actor's own count doesn't matter, nor the target's.
    [
      'owner with one workspace still removes a member',
      aliceOnlyT,
      TEAM,
      member('mia', 'member'),
      true,
    ],
    ['admin with one workspace still removes a viewer', adam, TEAM, member('vic', 'viewer'), true],
    [
      'the owner of a workspace of one removes a member',
      alice,
      SOLO,
      member('mia', 'member', 1, S),
      true,
    ],
    [
      'the only owner of a workspace of one cannot leave it',
      alice,
      SOLO,
      member('alice', 'owner', 1, S),
      false,
    ],
    [
      'target from another workspace is rejected',
      alice,
      TEAM,
      member('olly', 'member', 1, B),
      false,
    ],
    ['owner of B cannot remove from T', olly, TEAM, member('mia', 'member'), false],
    ['non-member cannot “leave” for someone else', olly, TEAM, member('olly', 'member'), false],
    ['anonymous cannot remove', anon, TEAM, member('mia', 'member'), false],
  ])('%s', (_label, c, w, target, expected) => {
    expect(canRemoveMember(c, w, target)).toBe(expected);
  });
});

describe('canDeleteWorkspace', () => {
  it.each<Case<WorkspaceAccess>>([
    ['owner deletes a workspace when they have another', alice, TEAM, true],
    ['owner deletes a workspace of one when they have another (D-36)', alice, SOLO, true],
    ['owner cannot delete their only workspace', aliceOnlyT, TEAM, false],
    ['owner of B (their only workspace) cannot delete it', olly, OTHER, false],
    ['admin with two workspaces cannot delete', adamInTwo, TEAM, false],
    ['admin cannot delete', adam, TEAM, false],
    ['member cannot delete', mia, TEAM, false],
    ['viewer cannot delete', vic, TEAM, false],
    ['owner of B cannot delete T', olly, TEAM, false],
    ['anonymous cannot delete', anon, TEAM, false],
    ['anonymous context with spoofed memberships cannot delete', anonSpoofed, TEAM, false],
  ])('%s', (_label, c, w, expected) => {
    expect(canDeleteWorkspace(c, w)).toBe(expected);
  });
});

// -------------------------------------------------------------------------------------------------------
// Context, helpers, assertions
// -------------------------------------------------------------------------------------------------------

describe('createPermissionContext', () => {
  it('keeps only the actor’s own memberships', () => {
    const c = createPermissionContext({
      userId: 'mia',
      memberships: [
        { workspaceId: T, userId: 'mia', role: 'member' },
        { workspaceId: B, userId: 'olly', role: 'owner' },
      ],
    });
    expect([...c.memberships]).toEqual([[T, 'member']]);
    expect(c).not.toHaveProperty('shareToken');
  });

  it('gives anonymous actors no memberships even if rows are passed', () => {
    const c = createPermissionContext({
      userId: null,
      memberships: [{ workspaceId: T, userId: '', role: 'owner' }],
      shareToken: TOKEN,
    });
    expect(c.memberships.size).toBe(0);
    expect(c.shareToken).toBe(TOKEN);
  });

  it('defaults to no memberships', () => {
    expect(createPermissionContext({ userId: 'mia' }).memberships.size).toBe(0);
  });
});

describe('isLastWorkspace', () => {
  it('is true only for a member whose single membership is that workspace', () => {
    expect(isLastWorkspace(mia, T)).toBe(true);
    expect(isLastWorkspace(alice, T)).toBe(false);
    expect(isLastWorkspace(miaInTwo, T)).toBe(false);
    // Not a member there (or anonymous): there is nothing to leave.
    expect(isLastWorkspace(olly, T)).toBe(false);
    expect(isLastWorkspace(anon, T)).toBe(false);
  });

  it('assertCan refuses leaving and deleting the last workspace', () => {
    expect(() => assertCan('removeMember', mia, TEAM, member('mia', 'member'))).toThrow(
      ForbiddenError,
    );
    expect(() => assertCan('deleteWorkspace', aliceOnlyT, TEAM)).toThrow(ForbiddenError);
    expect(() => assertCan('removeMember', miaInTwo, TEAM, member('mia', 'member'))).not.toThrow();
    expect(() => assertCan('deleteWorkspace', alice, TEAM)).not.toThrow();
  });
});

describe('helpers', () => {
  it('roleAtLeast follows owner > admin > member > viewer', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'member')).toBe(false);
  });

  it('roleIn reads the resource’s workspace only', () => {
    expect(roleIn(alice, T)).toBe('owner');
    expect(roleIn(alice, B)).toBeUndefined();
    expect(roleIn(anonSpoofed, T)).toBeUndefined();
  });
});

describe('assertCan', () => {
  it('returns when allowed', () => {
    expect(() => assertCan('editDocument', mia, wsDoc)).not.toThrow();
    expect(() =>
      assertCan('changeRole', alice, TEAM, member('mia', 'member'), 'admin'),
    ).not.toThrow();
  });

  it('throws a typed ForbiddenError when denied', () => {
    let caught: unknown;
    try {
      assertCan('readDocument', anon, priv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect(isForbiddenError(caught)).toBe(true);
    const e = caught as ForbiddenError;
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ForbiddenError');
    expect(e.code).toBe('FORBIDDEN');
    expect(e.status).toBe(403);
    expect(e.action).toBe('readDocument');
    expect(e.message).toBe('Forbidden: readDocument');
  });

  it.each(Object.keys(permissions))('dispatches %s to its check', (action) => {
    // Everything denies an anonymous actor without a token.
    const args: Record<string, unknown[]> = {
      invite: [TEAM, 'viewer'],
      changeRole: [TEAM, member('mia', 'member'), 'viewer'],
      removeMember: [TEAM, member('mia', 'member')],
      moveDocument: [wsDoc, null],
      moveFolder: [wsFolder, null, []],
      setFolderVisibility: [wsFolder, 'private', []],
      addDomain: [TEAM, { email: 'a@acme.test', emailVerified: true }, 'acme.test'],
      autoJoin: [
        { id: T, joinPolicy: 'auto_join', domains: ['acme.test'], deletedAt: null },
        { email: 'a@acme.test', emailVerified: true },
        null,
      ],
      requestToJoin: [
        { id: T, joinPolicy: 'request', domains: ['acme.test'], deletedAt: null },
        { email: 'a@acme.test', emailVerified: true },
        null,
      ],
      decideJoinRequest: [TEAM, { workspaceId: T, status: 'pending' }],
    };
    const resource = action.endsWith('Folder')
      ? wsFolder
      : action.endsWith('Document')
        ? linkDoc
        : TEAM;
    expect(() =>
      (assertCan as (a: string, c: PermissionContext, ...rest: unknown[]) => void)(
        action,
        anon,
        ...(args[action] ?? [resource]),
      ),
    ).toThrow(ForbiddenError);
  });

  it.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    'readDocuments',
    '',
  ])('fails closed for non-own action name %j', (action) => {
    const untyped = assertCan as (a: string, c: PermissionContext, ...rest: unknown[]) => void;
    expect(() => untyped(action, anon, {})).toThrow(ForbiddenError);
    expect(() => untyped(action, alice, wsDoc)).toThrow(`Forbidden: ${action}`);
  });

  it('fails closed when a check returns a non-true value on malformed input', () => {
    const bogus = { ...wsDoc, visibility: 'public' } as unknown as DocumentAccess;
    expect(() => assertCan('readDocument', adam, bogus)).toThrow(ForbiddenError);
  });

  it('the check map is frozen', () => {
    expect(Object.isFrozen(permissions)).toBe(true);
  });

  it('isForbiddenError rejects other errors', () => {
    expect(isForbiddenError(new Error('Forbidden: readDocument'))).toBe(false);
    expect(isForbiddenError(undefined)).toBe(false);
  });

  it('is type-checked against each action’s arguments', () => {
    expectTypeOf(assertCan<'invite'>).parameters.toEqualTypeOf<
      [action: 'invite', ctx: PermissionContext, workspace: WorkspaceAccess, role: Role]
    >();
    // A full Document satisfies DocumentAccess.
    expectTypeOf<Document>().toExtend<DocumentAccess>();
    // @ts-expect-error — editDocument needs a document, not a folder.
    expect(() => assertCan('editDocument', mia, { ...wsFolder, ownerId: 'x' })).toThrow();
  });
});
