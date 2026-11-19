import { cn } from '@oat/ui';
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';

/**
 * A workspace's square tile: its emoji icon, else the first letter of its name (personal workspaces in
 * the oat brand colour, team workspaces in gray). Shared by the switcher and the settings pages.
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
          'rounded-md',
          size === 'lg' ? 'text-heading-20' : 'text-label-12',
          workspace.icon
            ? 'bg-gray-100'
            : workspace.kind === 'personal'
              ? 'bg-brand-700 text-brand-on'
              : 'bg-gray-200 text-gray-1000',
        )}
      >
        {workspace.icon ?? workspace.name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
