import { Button } from '@oat/ui/components/button';
import { ArrowLeftIcon } from 'lucide-react';

import { StorageSettings } from './storage-settings.tsx';

/**
 * The desktop Settings view (3.8), shown in place of the meeting view. Storage is its only section for
 * now; later settings (audio devices, account…) stack below it. A recording keeps running meanwhile.
 */
export function SettingsView({ onClose }: { onClose: () => void }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings" data-testid="settings">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="settings-close">
          <ArrowLeftIcon data-icon="inline-start" />
          Back to meeting
        </Button>
        <h1 className="font-heading text-sm font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-6">
          <StorageSettings />
        </div>
      </div>
    </section>
  );
}
