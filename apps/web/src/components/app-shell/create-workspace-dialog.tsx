'use client';

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
import { Loader2Icon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { createTeamWorkspace } from '@/server/actions/workspaces';

/** Minimal "new team workspace" dialog: a name, then switch to it. Settings and invites come in 5.x. */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
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
      <DialogContent data-testid="create-workspace-dialog">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('name') ?? '');
            startTransition(async () => {
              const result = await createTeamWorkspace(name);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setError(null);
              onOpenChange(false);
              toast.success(`Created ${name.trim()}`);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a team workspace</DialogTitle>
            <DialogDescription>
              A shared space for your team’s notes. You can invite people once it exists.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              name="name"
              placeholder="Acme Design"
              maxLength={60}
              required
              autoFocus
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'workspace-name-error' : undefined}
            />
            {error && (
              <p id="workspace-name-error" role="alert" className="text-xs text-destructive">
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
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
