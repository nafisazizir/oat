import { JoinPolicySchema, RoleSchema, type JoinPolicy, type Role } from '@oat/core';
import { z } from 'zod';

export const WorkspaceId = z.string().min(1).max(100);
export const WorkspaceName = z
  .string()
  .trim()
  .min(1, 'Give the workspace a name.')
  .max(60, 'Keep the name under 60 characters.');
export const WorkspaceEmail = z.email('Enter a valid email address.').max(254);
export const CreateWorkspaceSchema = z.object({ name: WorkspaceName });
export const ActiveWorkspaceSchema = z.object({ workspaceId: WorkspaceId });
export const UpdateWorkspaceSchema = z.object({ name: WorkspaceName, icon: z.string().nullable() });
export const DeleteWorkspaceSchema = z.object({ confirmName: z.string() });
export const MemberRoleSchema = z.object({ role: RoleSchema });
export const InviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(WorkspaceEmail),
  role: RoleSchema,
});
export const InviteTokenSchema = z.object({ token: z.string().min(1) });
export const JoinPolicyInputSchema = z.object({ policy: JoinPolicySchema });
export const RemoveDomainSchema = z.object({ domain: z.string().min(1).max(253) });
export type MutationResult = { ok: true };
export type InviteLanding =
  | { state: 'invalid' }
  | {
      state: 'pending' | 'expired' | 'canceled' | 'rejected' | 'accepted';
      workspace: { id: string; name: string };
      inviter: string;
      email: string;
      role: Role;
      viewerEmail: string;
      access: 'invited' | 'wrong-account' | 'member';
    };
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceSchema>;
export type DeleteWorkspaceInput = z.infer<typeof DeleteWorkspaceSchema>;
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;
export type MemberRoleInput = z.infer<typeof MemberRoleSchema>;
export type JoinPolicyInput = z.infer<typeof JoinPolicyInputSchema>;
export type RemoveDomainInput = z.infer<typeof RemoveDomainSchema>;
export type WorkspaceMutationResult = { ok: true; workspaceId: string };
export interface JoinChoices {
  invites: {
    token: string;
    role: Role;
    workspace: { id: string; name: string; logo: string | null };
    invitedBy: string;
  }[];
  workspaces: {
    id: string;
    name: string;
    logo: string | null;
    memberCount: number;
    option: 'join' | 'request' | 'requested';
  }[];
}
export interface WorkspaceList {
  workspaces: {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
    role: Role;
    memberCount: number;
    joinedAt: string;
  }[];
  activeWorkspaceId: string | null;
}
export interface CalendarConnectionStatus {
  connected: boolean;
  email: string | null;
  hasCalendarScope: boolean;
  connectedAt: string | null;
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  isYou: boolean;
  /** Roles the viewer may change this member to (empty: no role picker). */
  assignableRoles: Role[];
  canRemove: boolean;
}

export interface InviteView {
  id: string;
  email: string;
  role: Role;
  state: 'pending' | 'expired';
  expiresAt: string;
  invitedBy: string;
  /** Resending re-checks that the viewer may invite with this role. */
  canResend: boolean;
}

/** Someone asking to join (D-36); only loaded for people who manage members. */
export interface JoinRequestView {
  id: string;
  name: string;
  email: string;
  image: string | null;
  requestedAt: string;
}

/** The join policy and allowed domains, for the people who may change them. */
export interface JoiningView {
  policy: JoinPolicy;
  domains: string[];
  /**
   * The one domain the viewer could add — their own verified email's — and whether it is listed already;
   * or why they have none to add (`public`: a public mailbox address; `unverified`).
   */
  ownDomain:
    { domain: string; listed: boolean } | { domain: null; reason: 'public' | 'unverified' };
}

export interface WorkspaceSettings {
  restoreDays: number;
  workspace: {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
  };
  role: Role;
  /** Name/icon changes and member management (owners and admins). */
  canManage: boolean;
  /** Roles the viewer may invite with (empty: no invite button). */
  inviteRoles: Role[];
  canLeave: boolean;
  canDelete: boolean;
  /**
   * This is the only workspace the viewer belongs to (D-36): it can't be left or deleted until they create or
   * join another one — the settings page says so instead of only disabling the buttons.
   */
  lastWorkspace: boolean;
  members: MemberView[];
  /** Pending and expired invitations; only loaded for people who manage members. */
  invites: InviteView[];
  /** Join policy + domains (D-36); `null` for people who can't edit them (they don't see them either). */
  joining: JoiningView | null;
  /** Requests to join waiting for a decision; empty for people who can't decide them. */
  joinRequests: JoinRequestView[];
  /** Roles the viewer may approve a request with (at most their own). */
  approveRoles: Role[];
}
