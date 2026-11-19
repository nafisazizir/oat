'use client';

import type { Role } from '@oat/core';
import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Loader2Icon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ROLE_INFO } from '@/lib/workspace';
import { inviteMember } from '@/server/actions/members';

/** Email + role (at most the inviter's own role). The invite email links to `/invite/<token>`. */
export function InviteDialog({
  workspace,
  roles,
  open,
  onOpenChange,
}: {
  workspace: { id: string; name: string };
  roles: Role[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const defaultRole: Role = roles.includes('member') ? 'member' : (roles.at(-1) ?? 'viewer');
  const [role, setRole] = useState<Role>(defaultRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setRole(defaultRole);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="invite-dialog">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(new FormData(event.currentTarget).get('email') ?? '');
            startTransition(async () => {
              const result = await inviteMember({ workspaceId: workspace.id, email, role });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setError(null);
              onOpenChange(false);
              toast.success(`Invite sent to ${email.trim()}`);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite people to {workspace.name}</DialogTitle>
            <DialogDescription>
              They’ll get an email with a link. It works for 7 days, for that address only.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                placeholder="name@company.com"
                required
                autoFocus
                autoComplete="off"
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'invite-error' : undefined}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                items={roles.map((value) => ({ value, label: ROLE_INFO[value].label }))}
                value={role}
                onValueChange={(value) => setRole(value as Role)}
              >
                <SelectTrigger id="invite-role" className="w-full" disabled={pending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_INFO[r].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{ROLE_INFO[role].description}</p>
            </div>
            {error && (
              <p id="invite-error" role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
