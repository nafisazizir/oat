'use client';

import { useSettings, useWorkspaceAction } from './services';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Spinner } from '@oat/ui/components/spinner';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ROLE_INFO } from './workspace';

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
  const { client } = useSettings();
  const run = useWorkspaceAction();
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
      <DialogContent data-testid="invite-dialog" className="sm:max-w-[22.5rem]">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const email = String(new FormData(event.currentTarget).get('email') ?? '');
            startTransition(async () => {
              const result = await run(() =>
                client.workspaces.invite(workspace.id, { email, role }),
              );
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
            <DialogDescription>Email a private invitation, valid for 7 days.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-5">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input
                id="invite-email"
                name="email"
                type="email"
                placeholder="name@company.com"
                required
                autoFocus
                autoComplete="off"
                disabled={pending}
                onChange={() => error && setError(null)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'invite-error' : undefined}
              />
              {error && (
                <FieldError id="invite-error" role="alert">
                  {error}
                </FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
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
              <FieldDescription>{ROLE_INFO[role].description}</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
