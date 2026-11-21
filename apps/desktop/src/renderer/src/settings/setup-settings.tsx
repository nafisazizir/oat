/**
 * Settings → Setup (9.2): what Oat may use on this Mac (microphone, system audio, calendars) at a glance, and
 * "Open setup" to run the walkthrough again (permissions + a test recording).
 */
import { Button } from '@oat/ui/components/button';
import { Skeleton } from '@oat/ui/components/skeleton';
import { cn } from '@oat/ui/lib/utils';
import { IconChevronRight } from '@tabler/icons-react';

import { usePermissions } from '../onboarding/onboarding-state.ts';
import { type PermissionView, stepView } from '../onboarding/onboarding-steps.ts';
import { SettingsHeader } from './settings-view.tsx';

const LABEL: Record<PermissionView, string> = {
  done: 'Allowed',
  ask: 'Not allowed yet',
  blocked: 'Turned off',
  unsupported: 'Not available',
  off: 'Not used here',
};

const ROWS = [
  ['Microphone', 'microphone'],
  ['System audio', 'system-audio'],
  ['Calendar', 'calendar'],
] as const;

export function SetupSettings({
  onOpenSetup,
  title = 'Setup',
}: {
  onOpenSetup: () => void;
  title?: string;
}) {
  const permissions = usePermissions();
  return (
    <div className="flex flex-col gap-4" data-testid="setup-settings">
      <SettingsHeader title={title} />
      <div className="flex flex-col">
        <dl className="flex flex-col" aria-busy={permissions ? undefined : true}>
          {ROWS.map(([label, step]) => {
            const view = permissions ? stepView(step, permissions)! : null;
            return (
              <div key={label} className="flex min-h-12 items-center justify-between gap-4 py-3">
                <dt className="text-label-14 text-gray-1000">{label}</dt>
                {view ? (
                  <dd
                    className={cn(
                      'text-label-14 text-gray-900',
                      view === 'done' && 'text-green-900',
                      view === 'blocked' && 'text-red-900',
                    )}
                    data-testid={`setup-${step}`}
                    data-state={view}
                  >
                    {LABEL[view]}
                  </dd>
                ) : (
                  <Skeleton className="h-4 w-20" />
                )}
              </div>
            );
          })}
        </dl>
        <div className="flex items-center justify-between gap-4 py-3">
          <span className="text-copy-14 text-gray-900">Permissions and a test recording</span>
          <Button variant="outline" size="sm" onClick={onOpenSetup} data-testid="open-setup">
            Open setup
            <IconChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
