import { Button } from '@oat/ui/components/button';
import { Kbd } from '@oat/ui/components/kbd';
import { IconArrowLeft } from '@tabler/icons-react';
import { useEffect } from 'react';

import { escapeClosesView } from '../keyboard.ts';

import { RecordingSettings } from './recording-settings.tsx';
import { SetupSettings } from './setup-settings.tsx';
import { StorageSettings } from './storage-settings.tsx';

/**
 * The desktop Settings view (3.8), shown in place of the meeting view: Setup (9.2: permissions, run setup
 * again), Recording (7.5: auto-stop) and Storage. A recording keeps running meanwhile. Esc goes back.
 */
export function SettingsView({
  onClose,
  onOpenSetup,
}: {
  onClose: () => void;
  onOpenSetup: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (escapeClosesView(event, document)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings" data-testid="settings">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-alpha-400 ps-2 pe-4">
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="settings-close">
          <IconArrowLeft data-icon="inline-start" />
          Back
          <Kbd className="ms-1">Esc</Kbd>
        </Button>
        <h1 className="text-display-14 text-gray-1000">Settings</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 py-8">
          <SetupSettings onOpenSetup={onOpenSetup} />
          <RecordingSettings />
          <StorageSettings />
        </div>
      </div>
    </section>
  );
}

/** A settings section's heading and one-line description. */
export function SettingsHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-heading-16 text-gray-1000">{title}</h2>
      <p className="text-copy-14 text-gray-900">{description}</p>
    </div>
  );
}
