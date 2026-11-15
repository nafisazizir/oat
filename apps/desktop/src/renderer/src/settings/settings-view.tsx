import { Button } from '@oat/ui/components/button';
import { ArrowLeftIcon } from 'lucide-react';

import { RecordingSettings } from './recording-settings.tsx';
import { SetupSettings } from './setup-settings.tsx';
import { StorageSettings } from './storage-settings.tsx';

/**
 * The desktop Settings view (3.8), shown in place of the meeting view: Setup (9.2: permissions, run setup
 * again), Recording (7.5: auto-stop) and Storage; later settings (audio devices, account…) stack below. A
 * recording keeps running meanwhile.
 */
export function SettingsView({
  onClose,
  onOpenSetup,
}: {
  onClose: () => void;
  onOpenSetup: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings" data-testid="settings">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="settings-close">
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <h1 className="font-heading text-sm font-semibold">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-6">
          <SetupSettings onOpenSetup={onOpenSetup} />
          <RecordingSettings />
          <StorageSettings />
        </div>
      </div>
    </section>
  );
}
