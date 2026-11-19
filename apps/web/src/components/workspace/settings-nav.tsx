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
    <nav aria-label="Workspace settings" className="flex gap-4 border-b border-gray-alpha-400">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px flex h-9 items-center border-b-2 text-button-14 transition-colors duration-fast outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-gray-600/50',
              active
                ? 'border-gray-1000 text-gray-1000'
                : 'border-transparent text-gray-900 hover:text-gray-1000',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
