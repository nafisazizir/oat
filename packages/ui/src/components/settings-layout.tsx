import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export function SettingsLayout({
  navigation,
  children,
}: {
  navigation: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl items-start gap-8 px-6 py-8 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-12">
      <nav aria-label="Settings sections" className="flex flex-col gap-6 md:sticky md:top-20">
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
    <div className="flex flex-col gap-1">
      <h2 className="px-2 pb-1 text-label-12 text-gray-900">{label}</h2>
      {children}
    </div>
  );
}

export function settingsNavClass(active: boolean) {
  return cn(
    'flex min-h-8 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-start text-label-14 transition-colors outline-none focus-visible:border-gray-600 focus-visible:ring-3 focus-visible:ring-gray-600/50',
    active
      ? 'bg-gray-alpha-200 text-gray-1000'
      : 'text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000',
  );
}
