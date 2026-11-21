/**
 * Joining a workspace by email domain (D-36): who may list a domain, who is shown a workspace, who may ask
 * or join, and who decides a request. Mostly deny cases.
 */
import { describe, expect, it } from 'vitest';

import {
  assertCan,
  canAddDomain,
  canAutoJoin,
  canDecideJoinRequest,
  canEditJoinSettings,
  canRequestToJoin,
  createPermissionContext,
  type EmailIdentity,
  ForbiddenError,
  type JoinableWorkspaceAccess,
  joinOption,
  type JoinRequestAccess,
  matchingJoinDomain,
  type PermissionContext,
} from './permissions.ts';
import { JOIN_POLICIES, type JoinPolicy, type Role, ROLES } from './types.ts';

const T = 'ws-team';
const B = 'ws-other';

function ctx(userId: string | null, roles: Record<string, Role> = {}): PermissionContext {
  return createPermissionContext({
    userId,
    memberships: Object.entries(roles).map(([workspaceId, role]) => ({
      workspaceId,
      userId: userId ?? 'nobody',
      role,
    })),
  });
}

const owner = ctx('alice', { [T]: 'owner' });
const admin = ctx('adam', { [T]: 'admin' });
const member = ctx('mia', { [T]: 'member' });
const viewer = ctx('vic', { [T]: 'viewer' });
const ownerElsewhere = ctx('olly', { [B]: 'owner' });
const stranger = ctx('sam');
const anon = ctx(null);

const verified = (email: string): EmailIdentity => ({ email, emailVerified: true });
const unverified = (email: string): EmailIdentity => ({ email, emailVerified: false });

function workspace(
  joinPolicy: JoinPolicy,
  overrides: Partial<JoinableWorkspaceAccess> = {},
): JoinableWorkspaceAccess {
  return { id: T, joinPolicy, domains: ['acme.test'], deletedAt: null, ...overrides };
}

const sam = verified('sam@acme.test');

describe('matchingJoinDomain', () => {
  it('matches a verified address on a listed domain, whatever the case', () => {
    expect(matchingJoinDomain(workspace('request'), sam)).toBe('acme.test');
    expect(matchingJoinDomain(workspace('request'), verified('Sam@ACME.Test'))).toBe('acme.test');
    expect(
      matchingJoinDomain(workspace('request', { domains: ['other.test', 'ACME.test'] }), sam),
    ).toBe('acme.test');
  });

  it('never matches an unverified address', () => {
    expect(matchingJoinDomain(workspace('auto_join'), unverified('sam@acme.test'))).toBeNull();
  });

  it('never matches a public mailbox domain, even if a workspace lists it', () => {
    const listed = workspace('auto_join', { domains: ['gmail.com', 'outlook.com'] });
    expect(matchingJoinDomain(listed, verified('sam@gmail.com'))).toBeNull();
    expect(matchingJoinDomain(listed, verified('sam@outlook.com'))).toBeNull();
  });

  it('never matches another domain, a subdomain, a lookalike or a malformed address', () => {
    const ws = workspace('auto_join');
    for (const email of [
      'sam@other.test',
      'sam@mail.acme.test',
      'sam@acme.test.evil.test',
      'sam@notacme.test',
      'acme.test',
      'sam@',
      '@acme.test',
      '',
    ]) {
      expect(matchingJoinDomain(ws, verified(email)), email).toBeNull();
    }
  });

  it('never matches a workspace without domains or a deleted one', () => {
    expect(matchingJoinDomain(workspace('auto_join', { domains: [] }), sam)).toBeNull();
    expect(matchingJoinDomain(workspace('auto_join', { deletedAt: new Date() }), sam)).toBeNull();
  });
});

describe('canEditJoinSettings', () => {
  it('allows owners and admins only', () => {
    expect(canEditJoinSettings(owner, { id: T })).toBe(true);
    expect(canEditJoinSettings(admin, { id: T })).toBe(true);
    for (const actor of [member, viewer, ownerElsewhere, stranger, anon]) {
      expect(canEditJoinSettings(actor, { id: T })).toBe(false);
    }
  });
});

describe('canAddDomain', () => {
  const alice = verified('alice@acme.test');

  it('allows an owner/admin to add the domain of their own verified email', () => {
    expect(canAddDomain(owner, { id: T }, alice, 'acme.test')).toBe(true);
    expect(canAddDomain(admin, { id: T }, verified('adam@acme.test'), ' @ACME.test ')).toBe(true);
  });

  it('denies a domain other than their own', () => {
    expect(canAddDomain(owner, { id: T }, alice, 'other.test')).toBe(false);
    expect(canAddDomain(owner, { id: T }, alice, 'mail.acme.test')).toBe(false);
    expect(canAddDomain(owner, { id: T }, alice, 'test')).toBe(false);
    expect(canAddDomain(owner, { id: T }, alice, '')).toBe(false);
  });

  it('denies an unverified email', () => {
    expect(canAddDomain(owner, { id: T }, unverified('alice@acme.test'), 'acme.test')).toBe(false);
  });

  it('denies a public mailbox domain, even the actor’s own', () => {
    for (const domain of ['gmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'yahoo.com']) {
      expect(canAddDomain(owner, { id: T }, verified(`alice@${domain}`), domain), domain).toBe(
        false,
      );
    }
  });

  it('denies an actor whose email has no usable domain', () => {
    expect(canAddDomain(owner, { id: T }, verified('alice'), 'acme.test')).toBe(false);
    expect(canAddDomain(owner, { id: T }, verified('alice@localhost'), 'localhost')).toBe(false);
  });

  it('denies members, viewers, owners of another workspace, strangers and anonymous callers', () => {
    for (const actor of [member, viewer, ownerElsewhere, stranger, anon]) {
      expect(canAddDomain(actor, { id: T }, alice, 'acme.test')).toBe(false);
    }
  });
});

describe('canAutoJoin', () => {
  it('allows a matching stranger into an auto_join workspace', () => {
    expect(canAutoJoin(stranger, workspace('auto_join'), sam)).toBe(true);
    // Membership elsewhere doesn't matter.
    expect(canAutoJoin(ownerElsewhere, workspace('auto_join'), sam)).toBe(true);
  });

  it('denies every other policy', () => {
    expect(canAutoJoin(stranger, workspace('invite_only'), sam)).toBe(false);
    expect(canAutoJoin(stranger, workspace('request'), sam)).toBe(false);
  });

  it('denies an unverified email, a public mailbox domain and a domain that is not listed', () => {
    expect(canAutoJoin(stranger, workspace('auto_join'), unverified('sam@acme.test'))).toBe(false);
    expect(
      canAutoJoin(
        stranger,
        workspace('auto_join', { domains: ['gmail.com'] }),
        verified('sam@gmail.com'),
      ),
    ).toBe(false);
    expect(canAutoJoin(stranger, workspace('auto_join'), verified('sam@other.test'))).toBe(false);
  });

  it('denies a deleted workspace, an existing member and an anonymous caller', () => {
    expect(canAutoJoin(stranger, workspace('auto_join', { deletedAt: new Date() }), sam)).toBe(
      false,
    );
    expect(canAutoJoin(member, workspace('auto_join'), sam)).toBe(false);
    expect(canAutoJoin(anon, workspace('auto_join'), sam)).toBe(false);
  });
});

describe('canRequestToJoin', () => {
  it('allows a matching stranger to ask a request workspace, also again after an approval', () => {
    expect(canRequestToJoin(stranger, workspace('request'), sam, null)).toBe(true);
    // Approved once, removed since: they may ask again.
    expect(canRequestToJoin(stranger, workspace('request'), sam, 'approved')).toBe(true);
  });

  it('denies a second request while one is pending, and any request after a decline', () => {
    expect(canRequestToJoin(stranger, workspace('request'), sam, 'pending')).toBe(false);
    expect(canRequestToJoin(stranger, workspace('request'), sam, 'declined')).toBe(false);
  });

  it('denies every other policy', () => {
    expect(canRequestToJoin(stranger, workspace('invite_only'), sam, null)).toBe(false);
    expect(canRequestToJoin(stranger, workspace('auto_join'), sam, null)).toBe(false);
  });

  it('denies an unverified email, a public mailbox domain and a domain that is not listed', () => {
    const ws = workspace('request');
    expect(canRequestToJoin(stranger, ws, unverified('sam@acme.test'), null)).toBe(false);
    expect(
      canRequestToJoin(
        stranger,
        workspace('request', { domains: ['hotmail.com'] }),
        verified('sam@hotmail.com'),
        null,
      ),
    ).toBe(false);
    expect(canRequestToJoin(stranger, ws, verified('sam@other.test'), null)).toBe(false);
  });

  it('denies a deleted workspace, an existing member and an anonymous caller', () => {
    expect(
      canRequestToJoin(stranger, workspace('request', { deletedAt: new Date() }), sam, null),
    ).toBe(false);
    expect(canRequestToJoin(viewer, workspace('request'), sam, null)).toBe(false);
    expect(canRequestToJoin(anon, workspace('request'), sam, null)).toBe(false);
  });
});

describe('joinOption', () => {
  it('never shows an invite_only workspace to a matching stranger', () => {
    expect(joinOption(stranger, workspace('invite_only'), sam, null)).toBeNull();
    expect(joinOption(stranger, workspace('invite_only'), sam, 'pending')).toBeNull();
    expect(joinOption(stranger, workspace('invite_only'), sam, 'approved')).toBeNull();
  });

  it('offers "request" for a request workspace and "join" for an auto_join one', () => {
    expect(joinOption(stranger, workspace('request'), sam, null)).toBe('request');
    expect(joinOption(stranger, workspace('auto_join'), sam, null)).toBe('join');
    // A request made before the policy became auto_join doesn't stand in the way.
    expect(joinOption(stranger, workspace('auto_join'), sam, 'pending')).toBe('join');
    expect(joinOption(stranger, workspace('auto_join'), sam, 'declined')).toBe('join');
  });

  it('shows a waiting request as "requested", and nothing after a decline', () => {
    expect(joinOption(stranger, workspace('request'), sam, 'pending')).toBe('requested');
    expect(joinOption(stranger, workspace('request'), sam, 'declined')).toBeNull();
  });

  it('shows nothing to people who don’t match, whatever the policy', () => {
    for (const policy of JOIN_POLICIES) {
      const ws = workspace(policy);
      expect(joinOption(stranger, ws, unverified('sam@acme.test'), null), policy).toBeNull();
      expect(joinOption(stranger, ws, verified('sam@other.test'), null), policy).toBeNull();
      expect(joinOption(stranger, ws, verified('sam@other.test'), 'pending'), policy).toBeNull();
      expect(joinOption(member, ws, sam, null), policy).toBeNull();
      expect(joinOption(anon, ws, sam, null), policy).toBeNull();
      expect(
        joinOption(stranger, workspace(policy, { deletedAt: new Date() }), sam, null),
        policy,
      ).toBeNull();
    }
  });
});

describe('canDecideJoinRequest', () => {
  const pending: JoinRequestAccess = { workspaceId: T, status: 'pending' };

  it('lets owners approve with any role and admins with at most admin; both may decline', () => {
    for (const role of ROLES) {
      expect(canDecideJoinRequest(owner, { id: T }, pending, role), role).toBe(true);
      expect(canDecideJoinRequest(admin, { id: T }, pending, role), role).toBe(role !== 'owner');
    }
    expect(canDecideJoinRequest(owner, { id: T }, pending)).toBe(true);
    expect(canDecideJoinRequest(admin, { id: T }, pending)).toBe(true);
  });

  it('denies members, viewers, owners of another workspace, strangers and anonymous callers', () => {
    for (const actor of [member, viewer, ownerElsewhere, stranger, anon]) {
      expect(canDecideJoinRequest(actor, { id: T }, pending)).toBe(false);
      expect(canDecideJoinRequest(actor, { id: T }, pending, 'viewer')).toBe(false);
    }
  });

  it('denies a request that belongs to another workspace', () => {
    const elsewhere: JoinRequestAccess = { workspaceId: B, status: 'pending' };
    expect(canDecideJoinRequest(owner, { id: T }, elsewhere)).toBe(false);
    expect(canDecideJoinRequest(owner, { id: T }, elsewhere, 'member')).toBe(false);
  });

  it('denies a request that was already decided', () => {
    for (const status of ['approved', 'declined'] as const) {
      expect(canDecideJoinRequest(owner, { id: T }, { workspaceId: T, status })).toBe(false);
      expect(canDecideJoinRequest(owner, { id: T }, { workspaceId: T, status }, 'member')).toBe(
        false,
      );
    }
  });
});

describe('assertCan (joining)', () => {
  it('throws ForbiddenError with the action name on a denial', () => {
    expect(() => assertCan('editJoinSettings', member, { id: T })).toThrow(ForbiddenError);
    expect(() =>
      assertCan('addDomain', owner, { id: T }, verified('alice@gmail.com'), 'gmail.com'),
    ).toThrow('Forbidden: addDomain');
    expect(() => assertCan('autoJoin', stranger, workspace('request'), sam)).toThrow(
      ForbiddenError,
    );
    expect(() =>
      assertCan('requestToJoin', stranger, workspace('request'), sam, 'declined'),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertCan(
        'decideJoinRequest',
        admin,
        { id: T },
        { workspaceId: T, status: 'pending' },
        'owner',
      ),
    ).toThrow(ForbiddenError);
  });

  it('passes when allowed', () => {
    expect(() => assertCan('editJoinSettings', admin, { id: T })).not.toThrow();
    expect(() =>
      assertCan('addDomain', owner, { id: T }, verified('alice@acme.test'), 'acme.test'),
    ).not.toThrow();
    expect(() => assertCan('autoJoin', stranger, workspace('auto_join'), sam)).not.toThrow();
    expect(() =>
      assertCan('requestToJoin', stranger, workspace('request'), sam, null),
    ).not.toThrow();
    expect(() =>
      assertCan('decideJoinRequest', admin, { id: T }, { workspaceId: T, status: 'pending' }),
    ).not.toThrow();
  });
});
