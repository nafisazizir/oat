'use client';

import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { Loader2Icon } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ICON_CHOICES } from '@/lib/workspace';
import { updateWorkspace } from '@/server/actions/members';

import { WorkspaceAvatar } from './workspace-avatar';

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-6">
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">{label}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Name + emoji icon (owners/admins), and the read-only address. */
export function WorkspaceGeneralForm({
  workspace,
  canEdit,
}: {
  workspace: { id: string; name: string; slug: string; icon: string | null };
  canEdit: boolean;
}) {
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState<string | null>(workspace.icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = name.trim() !== workspace.name || icon !== workspace.icon;

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await updateWorkspace({ workspaceId: workspace.id, name, icon });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setError(null);
          toast.success('Workspace saved');
        });
      }}
    >
      <div className="flex flex-col divide-y">
        <Field label="Icon" hint="Shown in the workspace switcher.">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="gap-2 pl-1.5"
                disabled={!canEdit || pending}
                aria-label="Choose workspace icon"
                data-testid="workspace-icon-button"
              >
                <WorkspaceAvatar workspace={{ name: name || workspace.name, kind: 'team', icon }} />
                {icon ? 'Change icon' : 'Add icon'}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto">
              <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Icons">
                {ICON_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="option"
                    aria-selected={choice === icon}
                    className="flex size-8 items-center justify-center rounded-md text-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:bg-accent"
                    onClick={() => {
                      setIcon(choice);
                      setPickerOpen(false);
                    }}
                  >
                    {choice}
                  </button>
                ))}
              </div>
              {icon && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={() => {
                    setIcon(null);
                    setPickerOpen(false);
                  }}
                >
                  Remove icon
                </Button>
              )}
            </PopoverContent>
          </Popover>
        </Field>
        <Field label={<Label htmlFor="workspace-settings-name">Name</Label>}>
          <Input
            id="workspace-settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            disabled={!canEdit || pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'workspace-settings-error' : undefined}
            className="sm:max-w-80"
          />
        </Field>
        <Field label="Address" hint="Used in links. It can’t be changed.">
          <code
            className="block truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground sm:max-w-80"
            data-testid="workspace-slug"
          >
            {workspace.slug}
          </code>
        </Field>
      </div>
      {error && (
        <p id="workspace-settings-error" role="alert" className="pt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {canEdit ? (
        <div className="flex justify-end pt-6">
          <Button type="submit" disabled={!dirty || pending}>
            {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Save changes
          </Button>
        </div>
      ) : (
        <p className="pt-6 text-xs text-muted-foreground">
          Only owners and admins can change these settings.
        </p>
      )}
    </form>
  );
}
