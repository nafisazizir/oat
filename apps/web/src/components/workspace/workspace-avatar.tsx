import { cn } from '@oat/ui';
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';

/**
 * A workspace's square tile: its emoji icon, else the first letter of its name (personal workspaces in
 * the primary colour, team workspaces in secondary). Shared by the switcher and the settings pages.
 */
export function WorkspaceAvatar({
  workspace,
  size = 'sm',
  className,
}: {
  workspace: { name: string; kind: 'personal' | 'team'; icon?: string | null };
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  return (
    <Avatar className={cn('rounded-md after:rounded-md', className)} size={size}>
      <AvatarFallback
        aria-hidden
        className={cn(
          'rounded-md font-semibold',
          size === 'lg' ? 'text-lg' : 'text-xs',
          workspace.icon
            ? 'bg-muted'
            : workspace.kind === 'personal'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground',
        )}
      >
        {workspace.icon ?? workspace.name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
