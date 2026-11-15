'use client';

import { cn } from '@oat/ui';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS: { href: Route; label: string }[] = [
  { href: '/settings/workspace', label: 'General' },
  { href: '/settings/workspace/members', label: 'Members' },
];

/** General / Members tabs for a team workspace's settings (links, so each tab has its own URL). */
export function WorkspaceSettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace settings" className="flex gap-1 border-b">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 pb-2 text-sm font-medium transition-colors duration-fast focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
