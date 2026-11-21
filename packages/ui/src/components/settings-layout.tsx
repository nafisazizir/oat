import type { ReactNode } from 'react';

import { cn } from '@oat/ui/lib/utils';

export function SettingsLayout({
  navigation,
  navigationClassName,
  children,
}: {
  navigation: ReactNode;
  navigationClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl items-start gap-8 px-6 py-8 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-12">
      <nav
        aria-label="Settings sections"
        className={cn(
          'flex flex-col gap-4 border-b border-gray-alpha-400 pb-4 md:sticky md:top-20 md:border-e md:border-b-0 md:pe-3 md:pb-0',
          navigationClassName,
        )}
      >
        {navigation}
      </nav>
      <div
        data-testid="settings-content"
        className="mx-auto flex w-full min-w-0 max-w-[640px] flex-col gap-8"
      >
        {children}
      </div>
    </div>
  );
}

export function SettingsNavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-label-12 text-gray-900">{label}</h2>
      {children}
    </div>
  );
}

export function settingsNavClass(active: boolean) {
  return cn(
    'flex min-h-8 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-start text-label-14 transition-colors outline-none focus-visible:border-gray-600 focus-visible:ring-3 focus-visible:ring-gray-600/50',
    active ? 'bg-gray-alpha-200 text-gray-1000' : 'text-gray-1000 hover:bg-gray-alpha-100',
  );
}
