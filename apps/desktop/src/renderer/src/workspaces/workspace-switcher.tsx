/**
 * Sidebar workspace switcher (3.9), like the web app's: my personal and team workspaces as synced to this
 * Mac. The meeting list shows the active workspace's notes, and new notes go there — unless I can only view
 * it, which the hint under the switcher says (they go to my personal workspace then).
 */
import type { DesktopWorkspace } from '@oat/core/bridge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { cn } from '@oat/ui/lib/utils';
import { CheckIcon, ChevronsUpDownIcon, EyeIcon } from 'lucide-react';
import { useState } from 'react';

import { BridgeCallError } from '../bridge.ts';
import { roleLabel, type WorkspacesView } from './workspaces-state.ts';

export function WorkspaceTile({
  workspace,
  className,
}: {
  workspace: Pick<DesktopWorkspace, 'name' | 'kind'>;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md font-heading text-xs font-semibold',
        workspace.kind === 'personal'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground',
        className,
      )}
    >
      {workspace.name.charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function WorkspaceSwitcher({ view }: { view: WorkspacesView }) {
  const [error, setError] = useState<string | null>(null);
  const { snapshot, active, fallback } = view;
  if (!snapshot || !active) return null;

  async function choose(id: string) {
    setError(null);
    try {
      await view.setActive(id);
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Couldn’t switch workspaces.');
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
          data-testid="workspace-switcher"
          data-workspace-id={active.id}
        >
          <WorkspaceTile workspace={active} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-none">
            {/* What the button is, before the visible text (WCAG 2.5.3: label in name). */}
            <span className="sr-only">Workspace: </span>
            <span className="truncate text-sm font-medium">{active.name}</span>
            <span className="truncate text-xs text-muted-foreground">{roleLabel(active)}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Workspaces
            </DropdownMenuLabel>
            {snapshot.workspaces.map((w) => (
              <DropdownMenuItem
                key={w.id}
                className="gap-2 py-1.5"
                data-testid="workspace-option"
                data-workspace-id={w.id}
                onClick={() => {
                  if (w.id !== active.id) void choose(w.id);
                }}
              >
                <WorkspaceTile workspace={w} className="size-6" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{w.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{roleLabel(w)}</span>
                </span>
                {w.id === active.id && <CheckIcon className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {fallback && (
        <p
          role="note"
          className="flex gap-1.5 px-1.5 text-xs text-muted-foreground"
          data-testid="workspace-hint"
        >
          <EyeIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>
            You can view {active.name} but not add notes to it. New notes go to {fallback.name}.
          </span>
        </p>
      )}
      {error && (
        <p role="status" className="px-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
