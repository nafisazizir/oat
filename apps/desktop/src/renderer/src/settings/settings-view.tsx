import { SettingsPanel, SettingsShell, useTheme, type SettingsSectionId } from '@oat/settings-ui';
import { Button } from '@oat/ui/components/button';
import { Kbd } from '@oat/ui/components/kbd';
import { IconArrowLeft } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { call } from '../bridge.ts';
import { escapeClosesView } from '../keyboard.ts';
import { api } from '../lib/api.ts';

import { RecordingSettings } from './recording-settings.tsx';
import { SetupSettings } from './setup-settings.tsx';
import { StorageSettings } from './storage-settings.tsx';

const refreshWorkspace = () => {
  void call('sync:now').catch(() => {});
};

export function SettingsView({
  initialSection,
  workspace,
  recordingActive,
  onClose,
  onOpenSetup,
  onWorkspaceExited,
}: {
  initialSection: SettingsSectionId;
  workspace: { id: string; name: string } | null;
  recordingActive: boolean;
  onClose: () => void;
  onOpenSetup: () => void;
  onWorkspaceExited: () => void;
}) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (escapeClosesView(event, document)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Settings" data-testid="settings">
      {/* A stable gutter: a page long enough to scroll doesn't nudge the others sideways. */}
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
        <SettingsShell
          active={section}
          navigationClassName="md:top-1"
          workspaceName={workspace?.name ?? ''}
          renderLink={(id, props) => (
            <button type="button" key={id} onClick={() => setSection(id)} {...props} />
          )}
          back={
            <Button
              variant="ghost"
              size="sm"
              // Arrow and label on the same columns as the section icons and names below.
              className="justify-start gap-2 pe-[7px] has-data-[icon=inline-start]:ps-[7px]"
              onClick={onClose}
              data-testid="settings-close"
            >
              <IconArrowLeft data-icon="inline-start" />
              Back<span className="sr-only"> to notes</span>
              <Kbd className="ms-auto">Esc</Kbd>
            </Button>
          }
          devicePanels={{
            setup: <SetupSettings onOpenSetup={onOpenSetup} />,
            recording: <RecordingSettings />,
            storage: <StorageSettings />,
          }}
        >
          {!workspace && ['integrations', 'workspace', 'members'].includes(section) ? (
            <p role="status" className="text-copy-14 text-gray-900">
              Connect to Oat and select a workspace to see these settings.
            </p>
          ) : (
            <SettingsPanel
              active={section}
              workspaceName={workspace?.name ?? ''}
              theme={theme}
              setTheme={setTheme}
              services={{
                client: api,
                workspaceId: workspace?.id ?? '',
                recordingActive,
                exportNotes: async (workspaceId) =>
                  (await call('settings:export-notes', { workspaceId }))?.count ?? null,
                connect: (provider, workspaceId) =>
                  call('settings:connect', { provider, workspaceId }),
                onProfileChanged: () => {
                  void call('api:me').catch(() => {});
                },
                onWorkspaceChanged: refreshWorkspace,
                onWorkspaceExited: () => {
                  refreshWorkspace();
                  onWorkspaceExited();
                },
              }}
            />
          )}
        </SettingsShell>
      </div>
    </section>
  );
}
