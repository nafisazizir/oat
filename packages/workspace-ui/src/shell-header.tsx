'use client';

import { SidebarProvider, SidebarTrigger, useSidebar } from '@oat/ui/components/sidebar';
import { cn } from '@oat/ui/lib/utils';

export function ShellSidebarProvider({
  style,
  ...props
}: React.ComponentProps<typeof SidebarProvider>) {
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '18.3125rem', ...style } as React.CSSProperties}
      {...props}
    />
  );
}

export function ShellHeader({ className, children, ...props }: React.ComponentProps<'header'>) {
  const { open, isMobile } = useSidebar();
  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 bg-background-100 px-3',
        className,
      )}
      {...props}
    >
      {(!open || isMobile) && (
        <SidebarTrigger className="app-no-drag" data-testid="sidebar-trigger" />
      )}
      <div className="ms-auto flex min-w-0 items-center gap-2">{children}</div>
    </header>
  );
}
