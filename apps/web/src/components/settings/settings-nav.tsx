'use client';

import { SettingsNavGroup, settingsNavClass } from '@oat/ui/components/settings-layout';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const groups: { label: string; links: { label: string; href: Route; testId?: string }[] }[] = [
  {
    label: 'Account',
    links: [
      { label: 'Profile', href: '/settings/profile', testId: 'settings-profile-link' },
      { label: 'Preferences', href: '/settings' },
      { label: 'Integrations', href: '/settings/integrations' },
    ],
  },
  {
    label: 'Workspace',
    links: [
      { label: 'General', href: '/settings/workspace' },
      { label: 'Members', href: '/settings/workspace/members' },
    ],
  },
];

export function SettingsNav({ workspace, team }: { workspace: string; team: boolean }) {
  const pathname = usePathname();
  return (
    <>
      {groups.map((group) => (
        <SettingsNavGroup key={group.label} label={group.label}>
          {group.label === 'Workspace' && (
            <p className="truncate px-2 pb-2 text-label-12 text-gray-900">{workspace}</p>
          )}
          {group.links
            .filter((link) => team || link.label !== 'Members')
            .map((link) => (
              <Link
                key={link.href}
                href={link.href}
                data-testid={link.testId}
                aria-current={pathname === link.href ? 'page' : undefined}
                className={settingsNavClass(pathname === link.href)}
              >
                {link.label}
              </Link>
            ))}
        </SettingsNavGroup>
      ))}
    </>
  );
}
