import { Button } from '@oat/ui/components/button';
import { Kbd } from '@oat/ui/components/kbd';
import {
  SettingsLayout,
  SettingsNavGroup,
  settingsNavClass,
} from '@oat/ui/components/settings-layout';
import { IconArrowLeft, IconArrowUpRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { call } from '../bridge.ts';
import { escapeClosesView } from '../keyboard.ts';
import { useRecordingAction } from '../recording/recording-controls.tsx';

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
  const [section, setSection] = useState<'preferences' | 'recording' | 'storage'>('preferences');
  const action = useRecordingAction();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (escapeClosesView(event, document)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings" data-testid="settings">
      <div className="min-h-0 flex-1 overflow-auto">
        <SettingsLayout
          navigationClassName="md:top-8"
          navigation={
            <>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={onClose}
                data-testid="settings-close"
              >
                <IconArrowLeft data-icon="inline-start" />
                {/* Named by what it shows ("Back …"), with where it goes for screen readers. */}
                Back<span className="sr-only"> to notes</span>
                <Kbd className="ms-auto">Esc</Kbd>
              </Button>
              <SettingsNavGroup label="Account">
                <button
                  type="button"
                  aria-label="Profile (opens in browser)"
                  disabled={action.pending}
                  className={settingsNavClass(false)}
                  onClick={() =>
                    void action.run(() => call('settings:open-web', { section: 'profile' }))
                  }
                >
                  Profile
                  <IconArrowUpRight aria-hidden className="ms-auto size-3.5" />
                  <span className="sr-only"> (opens in browser)</span>
                </button>
                {(['preferences', 'recording', 'storage'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    data-testid={`settings-section-${id}`}
                    aria-current={section === id ? 'page' : undefined}
                    className={settingsNavClass(section === id)}
                    onClick={() => setSection(id)}
                  >
                    {id === 'preferences'
                      ? 'Preferences'
                      : id === 'recording'
                        ? 'Recording'
                        : 'Storage'}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Integrations (opens in browser)"
                  disabled={action.pending}
                  className={settingsNavClass(false)}
                  onClick={() =>
                    void action.run(() => call('settings:open-web', { section: 'integrations' }))
                  }
                >
                  Integrations
                  <IconArrowUpRight aria-hidden className="ms-auto size-3.5" />
                  <span className="sr-only"> (opens in browser)</span>
                </button>
              </SettingsNavGroup>
              <SettingsNavGroup label="Workspace">
                {(['workspace', 'members'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-label={`${id === 'workspace' ? 'General' : 'Members'} (opens in browser)`}
                    disabled={action.pending}
                    className={settingsNavClass(false)}
                    onClick={() =>
                      void action.run(() => call('settings:open-web', { section: id }))
                    }
                  >
                    {id === 'workspace' ? 'General' : 'Members'}
                    <IconArrowUpRight aria-hidden className="ms-auto size-3.5" />
                    <span className="sr-only"> (opens in browser)</span>
                  </button>
                ))}
                {action.error && (
                  <p role="alert" className="px-2 text-copy-13 text-red-900">
                    {action.error}
                  </p>
                )}
              </SettingsNavGroup>
            </>
          }
        >
          <div hidden={section !== 'preferences'}>
            <SetupSettings title="Preferences" onOpenSetup={onOpenSetup} />
          </div>
          <div hidden={section !== 'recording'}>
            <RecordingSettings />
          </div>
          <div hidden={section !== 'storage'}>
            <StorageSettings />
          </div>
        </SettingsLayout>
      </div>
    </section>
  );
}

/** A settings section's heading and one-line description. */
export function SettingsHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-heading-24 text-gray-1000">{title}</h1>
      {description && <p className="text-copy-14 text-gray-900">{description}</p>}
    </div>
  );
}
