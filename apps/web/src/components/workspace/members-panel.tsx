'use client';

import type { Role } from '@oat/core';
import { Avatar, AvatarFallback, AvatarImage } from '@oat/ui/components/avatar';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@oat/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Loader2Icon, MailIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { expiresIn, ROLE_INFO } from '@/lib/workspace';
import { changeRole, removeMember, resendInvite, revokeInvite } from '@/server/actions/members';
import type { InviteView, MemberView, WorkspaceSettings } from '@/server/workspace-settings';

import { InviteDialog } from './invite-dialog';

function RoleControl({ workspaceId, member }: { workspaceId: string; member: MemberView }) {
  const [pending, startTransition] = useTransition();
  if (member.assignableRoles.length === 0) {
    return (
      <Badge variant="secondary" data-testid="member-role">
        {ROLE_INFO[member.role].label}
      </Badge>
    );
  }
  const options: Role[] = [member.role, ...member.assignableRoles];
  return (
    <Select
      items={options.map((value) => ({ value, label: ROLE_INFO[value].label }))}
      value={member.role}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const result = await changeRole({
            workspaceId,
            userId: member.userId,
            role: value as Role,
          });
          if (!result.ok) toast.error(result.error);
          else
            toast.success(`${member.name} is now ${ROLE_INFO[value as Role].label.toLowerCase()}`);
        })
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={`Role for ${member.name}`}
        data-testid="member-role-select"
        className="min-w-24"
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <SelectValue />}
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_INFO[role].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RemoveMemberDialog({
  workspace,
  member,
  open,
  onOpenChange,
}: {
  workspace: { id: string; name: string };
  member: MemberView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="remove-member-dialog">
        <DialogHeader>
          <DialogTitle>Remove {member.name}?</DialogTitle>
          <DialogDescription>
            {member.email} loses access to {workspace.name} and its shared notes right away. You can
            invite them again later.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeMember({
                  workspaceId: workspace.id,
                  userId: member.userId,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onOpenChange(false);
                toast.success(`Removed ${member.name}`);
              })
            }
          >
            {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  workspace,
  member,
}: {
  workspace: { id: string; name: string };
  member: MemberView;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid="member-row">
      <Avatar>
        {member.image && <AvatarImage src={member.image} alt="" />}
        <AvatarFallback className="text-xs font-semibold">
          {member.name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          {member.name}
          {member.isYou && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        <span className="truncate text-xs text-muted-foreground">{member.email}</span>
      </div>
      <RoleControl workspaceId={workspace.id} member={member} />
      {member.canRemove ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${member.name}`}
            onClick={() => setRemoveOpen(true)}
          >
            <UserMinusIcon />
          </Button>
          <RemoveMemberDialog
            workspace={workspace}
            member={member}
            open={removeOpen}
            onOpenChange={setRemoveOpen}
          />
        </>
      ) : (
        // Keeps the role column aligned with rows that have a remove button.
        <span aria-hidden className="size-7 shrink-0" />
      )}
    </li>
  );
}

function InviteRow({ invite }: { invite: InviteView }) {
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? 'Something went wrong.');
      else toast.success(done);
    });
  const expired = invite.state === 'expired';
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" data-testid="invite-row">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MailIcon className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{invite.email}</span>
        <span className="truncate text-xs text-muted-foreground">
          {ROLE_INFO[invite.role].label} · invited by {invite.invitedBy} ·{' '}
          {expired ? (
            <span className="text-destructive">expired</span>
          ) : (
            `expires ${expiresIn(new Date(invite.expiresAt))}`
          )}
        </span>
      </div>
      {invite.canResend && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(() => resendInvite(invite.id), `Invite resent to ${invite.email}`)}
        >
          Resend
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={pending}
        onClick={() => run(() => revokeInvite(invite.id), `Invite to ${invite.email} revoked`)}
      >
        Revoke
      </Button>
    </li>
  );
}

/** The members page: who's in, their roles, and pending invitations. */
export function MembersPanel({ settings }: { settings: WorkspaceSettings }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const { workspace, members, invites, inviteRoles } = settings;
  const count = members.length === 1 ? '1 member' : `${members.length} members`;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Members</h2>
          </CardTitle>
          <CardDescription>{count}</CardDescription>
          {inviteRoles.length > 0 && (
            <CardAction>
              <Button onClick={() => setInviteOpen(true)}>
                <UserPlusIcon data-icon="inline-start" />
                Invite people
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y" data-testid="member-list">
            {members.map((member) => (
              <MemberRow key={member.userId} workspace={workspace} member={member} />
            ))}
          </ul>
        </CardContent>
      </Card>

      {settings.canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Pending invites</h2>
            </CardTitle>
            <CardDescription>
              {invites.length === 0
                ? 'Nobody is waiting to join.'
                : 'Links stop working when they expire or are revoked.'}
            </CardDescription>
          </CardHeader>
          {invites.length > 0 && (
            <CardContent>
              <ul className="flex flex-col divide-y" data-testid="invite-list">
                {invites.map((invite) => (
                  <InviteRow key={invite.id} invite={invite} />
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
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
