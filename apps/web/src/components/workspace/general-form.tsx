'use client';

import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Button } from '@oat/ui/components/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@oat/ui/components/field';
import { Input } from '@oat/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { Spinner } from '@oat/ui/components/spinner';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ICON_CHOICES } from '@/lib/workspace';
import { updateWorkspace } from '@/server/actions/members';

import { WorkspaceAvatar } from './workspace-avatar';

/** Label column + control column on wide screens; stacked on narrow ones. */
const ROW = 'gap-2 sm:grid sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-6';

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
      className="flex flex-col gap-6"
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
      <FieldGroup className="gap-5">
        <Field className={ROW}>
          <FieldContent>
            <FieldTitle>Icon</FieldTitle>
            <FieldDescription>Shown in the workspace switcher.</FieldDescription>
          </FieldContent>
          <div>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    className="gap-2 ps-1.5"
                    disabled={!canEdit || pending}
                    data-testid="workspace-icon-button"
                  />
                }
              >
                <WorkspaceAvatar workspace={{ name: name || workspace.name, icon }} />
                {icon ? 'Change icon' : 'Add icon'}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto">
                <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Icons">
                  {ICON_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      role="option"
                      aria-selected={choice === icon}
                      className="flex size-8 items-center justify-center rounded-md text-heading-16 transition-colors duration-fast outline-none hover:bg-gray-alpha-200 focus-visible:ring-3 focus-visible:ring-gray-600/50 aria-selected:bg-gray-alpha-300"
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
          </div>
        </Field>
        <Field className={ROW} data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="workspace-settings-name">Name</FieldLabel>
          <Input
            id="workspace-settings-name"
            size="sm"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            maxLength={60}
            required
            disabled={!canEdit || pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'workspace-settings-error' : undefined}
            className="sm:max-w-80"
          />
        </Field>
        <Field className={ROW}>
          <FieldContent>
            <FieldTitle>Address</FieldTitle>
            <FieldDescription>Used in links. It can’t be changed.</FieldDescription>
          </FieldContent>
          <code
            className="block w-fit max-w-full truncate rounded-md bg-gray-100 px-2 py-1 text-label-13-mono text-gray-900 sm:max-w-80"
            data-testid="workspace-slug"
          >
            {workspace.slug}
          </code>
        </Field>
      </FieldGroup>
      {error && (
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertDescription id="workspace-settings-error">{error}</AlertDescription>
        </Alert>
      )}
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || pending}>
            {pending && <Spinner data-icon="inline-start" />}
            Save changes
          </Button>
        </div>
      ) : (
        <p className="text-copy-13 text-gray-900">
          Only owners and admins can change these settings.
        </p>
      )}
    </form>
  );
}
