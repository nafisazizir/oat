'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@oat/ui/components/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@oat/ui/components/avatar';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Spinner } from '@oat/ui/components/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@oat/ui/components/tooltip';
import { IconMail, IconUserMinus, IconUserPlus } from '@tabler/icons-react';
import type { Role } from '@oat/core';
import { useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { applyMembersAction, type MembersAction, runOptimistic } from '@/lib/members-optimistic';
import { expiresIn, isRole, ROLE_INFO, ROLES_DESC } from '@/lib/workspace';
import { approveJoinRequest, declineJoinRequest } from '@/server/actions/joining';
import { changeRole, removeMember, resendInvite, revokeInvite } from '@/server/actions/members';
import type {
  InviteView,
  JoinRequestView,
  MemberView,
  WorkspaceSettings,
} from '@/server/workspace-settings';

import { InviteDialog } from './invite-dialog';

type Apply = (action: MembersAction) => void;

/**
 * Rows share one column grid so roles and actions line up down the list. Only the bottom edge is drawn
 * (`Item` has a border on all four sides, transparent by default).
 */
const ROW = 'px-0 py-3 not-last:border-b not-last:border-b-gray-alpha-300 rounded-none';

function RoleControl({
  workspaceId,
  member,
  apply,
}: {
  workspaceId: string;
  member: MemberView;
  apply: Apply;
}) {
  const [, startTransition] = useTransition();
  if (member.assignableRoles.length === 0) {
    return (
      <span className="text-label-14 text-gray-900" data-testid="member-role">
        {ROLE_INFO[member.role].label}
      </span>
    );
  }
  const options = ROLES_DESC.filter((r) => r === member.role || member.assignableRoles.includes(r));
  return (
    <Select
      size="sm"
      items={options.map((value) => ({ value, label: ROLE_INFO[value].label }))}
      value={member.role}
      onValueChange={(value) => {
        // base-ui reports `null` when the items change under it (e.g. the optimistic role swap).
        if (!isRole(value) || value === member.role) return;
        const role = value;
        startTransition(async () => {
          const ok = await runOptimistic(
            () => apply({ type: 'role', userId: member.userId, role }),
            () => changeRole({ workspaceId, userId: member.userId, role }),
            (error) => toast.error('Couldn’t change the role', { description: error }),
          );
          if (ok) toast.success(`${member.name} is now ${ROLE_INFO[role].label.toLowerCase()}`);
        });
      }}
    >
      <SelectTrigger
        aria-label={`Role for ${member.name}`}
        data-testid="member-role-select"
        className="min-w-28"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        {options.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_INFO[role].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MemberRow({
  workspace,
  member,
  apply,
}: {
  workspace: { id: string; name: string };
  member: MemberView;
  apply: Apply;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [, startTransition] = useTransition();

  const remove = () => {
    setRemoveOpen(false);
    startTransition(async () => {
      const ok = await runOptimistic(
        () => apply({ type: 'remove-member', userId: member.userId }),
        () => removeMember({ workspaceId: workspace.id, userId: member.userId }),
        (error) => toast.error(`Couldn’t remove ${member.name}`, { description: error }),
      );
      if (ok) toast.success(`Removed ${member.name}`);
    });
  };

  return (
    <Item role="listitem" className={ROW} data-testid="member-row">
      <ItemMedia>
        <Avatar>
          {member.image && <AvatarImage src={member.image} alt="" />}
          <AvatarFallback>{member.name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0 text-label-14">
          <span className="truncate">{member.name}</span>
          {member.isYou && <Badge variant="secondary">You</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate text-copy-13">{member.email}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-1">
        <RoleControl workspaceId={workspace.id} member={member} apply={apply} />
        {member.canRemove ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => setRemoveOpen(true)}
                />
              }
            >
              <IconUserMinus />
            </TooltipTrigger>
            <TooltipContent>Remove from workspace</TooltipContent>
          </Tooltip>
        ) : (
          // Holds the remove column so roles line up with rows that have one.
          <span aria-hidden className="size-8 shrink-0" />
        )}
      </ItemActions>
      {member.canRemove && (
        <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
          <AlertDialogContent data-testid="remove-member-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {member.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {member.email} loses access to {workspace.name} and its shared notes right away. You
                can invite them again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={remove}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Item>
  );
}

function InviteRow({ invite, apply }: { invite: InviteView; apply: Apply }) {
  const [resending, startResend] = useTransition();
  const [, startRevoke] = useTransition();
  const expired = invite.state === 'expired';

  return (
    <Item role="listitem" className={ROW} data-testid="invite-row">
      <ItemMedia>
        <span className="flex size-8 items-center justify-center rounded-full bg-gray-100 text-gray-900">
          <IconMail className="size-4" />
        </span>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0 text-label-14">
          <span className="truncate">{invite.email}</span>
        </ItemTitle>
        <ItemDescription className="truncate text-copy-13">
          {ROLE_INFO[invite.role].label} ·{' '}
          {expired ? (
            <span className="text-red-900">expired</span>
          ) : (
            `expires ${expiresIn(new Date(invite.expiresAt))}`
          )}{' '}
          · invited by {invite.invitedBy}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="gap-1">
        {invite.canResend && (
          <Button
            variant="ghost"
            size="sm"
            disabled={resending}
            onClick={() =>
              startResend(async () => {
                const ok = await runOptimistic(
                  () => {},
                  () => resendInvite(invite.id),
                  (error) => toast.error('Couldn’t resend the invite', { description: error }),
                );
                if (ok) toast.success(`Invite resent to ${invite.email}`);
              })
            }
          >
            {resending && <Spinner data-icon="inline-start" />}
            Resend
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            startRevoke(async () => {
              const ok = await runOptimistic(
                () => apply({ type: 'remove-invite', inviteId: invite.id }),
                () => revokeInvite(invite.id),
                (error) => toast.error('Couldn’t revoke the invite', { description: error }),
              );
              if (ok) toast.success(`Invite to ${invite.email} revoked`);
            })
          }
        >
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}

/** Someone asking to join (D-36): pick the role they get and approve, or decline. */
function JoinRequestRow({ request, roles }: { request: JoinRequestView; roles: Role[] }) {
  const [role, setRole] = useState<Role>(
    roles.includes('member') ? 'member' : (roles.at(-1) ?? 'viewer'),
  );
  const [deciding, startDecision] = useTransition();
  const [choice, setChoice] = useState<'approve' | 'decline' | null>(null);
  const options = ROLES_DESC.filter((r) => roles.includes(r));

  const decide = (which: 'approve' | 'decline') => {
    setChoice(which);
    startDecision(async () => {
      const result =
        which === 'approve'
          ? await approveJoinRequest({ requestId: request.id, role })
          : await declineJoinRequest(request.id);
      if (!result.ok) {
        toast.error(
          which === 'approve' ? `Couldn’t approve ${request.name}` : 'Couldn’t decline the request',
          { description: result.error },
        );
      } else if (which === 'approve') {
        toast.success(`${request.name} joined as ${ROLE_INFO[role].label.toLowerCase()}`);
      } else {
        toast.success(`Request from ${request.name} declined`);
      }
    });
  };

  return (
    <Item role="listitem" className={ROW} data-testid="join-request-row">
      <ItemMedia>
        <Avatar>
          {request.image && <AvatarImage src={request.image} alt="" />}
          <AvatarFallback>{request.name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full min-w-0 text-label-14">
          <span className="truncate">{request.name}</span>
        </ItemTitle>
        <ItemDescription className="truncate text-copy-13">{request.email}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-1">
        <Select
          size="sm"
          items={options.map((value) => ({ value, label: ROLE_INFO[value].label }))}
          value={role}
          disabled={deciding}
          onValueChange={(value) => {
            if (isRole(value)) setRole(value);
          }}
        >
          <SelectTrigger
            aria-label={`Role for ${request.name}`}
            data-testid="join-request-role"
            className="min-w-28"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {ROLE_INFO[option].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          disabled={deciding}
          aria-label={`Decline ${request.name}`}
          onClick={() => decide('decline')}
        >
          {deciding && choice === 'decline' && <Spinner data-icon="inline-start" />}
          Decline
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={deciding}
          aria-label={`Approve ${request.name}`}
          onClick={() => decide('approve')}
        >
          {deciding && choice === 'approve' && <Spinner data-icon="inline-start" />}
          Approve
        </Button>
      </ItemActions>
    </Item>
  );
}

function Section({
  title,
  action,
  children,
  primary = false,
  testId,
}: {
  primary?: boolean;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex min-h-9 items-center justify-between gap-4">
        {primary ? (
          <h1 className="text-heading-24 text-gray-1000">{title}</h1>
        ) : (
          <h2 className="text-heading-16">{title}</h2>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The members page: who's in, their roles, requests to join and pending invitations. Member and invite
 * mutations apply optimistically; a decision on a request shows once the server has made it.
 */
export function MembersPanel({ settings }: { settings: WorkspaceSettings }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const { workspace, inviteRoles } = settings;
  const [{ members, invites }, apply] = useOptimistic(
    { members: settings.members, invites: settings.invites },
    applyMembersAction<MemberView, InviteView>,
  );

  return (
    <>
      <Section
        title="Members"
        primary
        action={
          inviteRoles.length > 0 && (
            <Button onClick={() => setInviteOpen(true)}>
              <IconUserPlus data-icon="inline-start" />
              Invite people
            </Button>
          )
        }
      >
        <ItemGroup className="gap-0" data-testid="member-list">
          {members.map((member) => (
            <MemberRow key={member.userId} workspace={workspace} member={member} apply={apply} />
          ))}
        </ItemGroup>
      </Section>

      {settings.joinRequests.length > 0 && (
        <Section title="Requests to join" testId="join-requests">
          <ItemGroup className="gap-0" data-testid="join-request-list">
            {settings.joinRequests.map((request) => (
              <JoinRequestRow key={request.id} request={request} roles={settings.approveRoles} />
            ))}
          </ItemGroup>
        </Section>
      )}

      {settings.canManage && invites.length > 0 && (
        <Section title="Pending invites">
          <ItemGroup className="gap-0" data-testid="invite-list">
            {invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} apply={apply} />
            ))}
          </ItemGroup>
        </Section>
      )}

      {inviteRoles.length > 0 && (
        <InviteDialog
          workspace={workspace}
          roles={inviteRoles}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
        />
      )}
    </>
  );
}
