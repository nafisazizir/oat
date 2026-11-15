/**
 * Settings → Setup (9.2): what Oat may use on this Mac (microphone, system audio, calendars) at a glance, and
 * "Open setup" to run the walkthrough again (permissions + a test recording).
 */
import { Button } from '@oat/ui/components/button';
import { Card, CardContent } from '@oat/ui/components/card';
import { Skeleton } from '@oat/ui/components/skeleton';
import { cn } from '@oat/ui/lib/utils';
import { ChevronRightIcon } from 'lucide-react';

import { usePermissions } from '../onboarding/onboarding-state.ts';
import { type PermissionView, stepView } from '../onboarding/onboarding-steps.ts';

const LABEL: Record<PermissionView, string> = {
  done: 'Allowed',
  ask: 'Not allowed yet',
  blocked: 'Turned off',
  unsupported: 'Not available',
  off: 'Not used here',
};

export function SetupSettings({ onOpenSetup }: { onOpenSetup: () => void }) {
  const permissions = usePermissions();
  const rows = permissions
    ? ([
        ['Microphone', stepView('microphone', permissions)!],
        ['System audio', stepView('system-audio', permissions)!],
        ['Calendar', stepView('calendar', permissions)!],
      ] as const)
    : null;
  return (
    <div className="flex flex-col gap-5" data-testid="setup-settings">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold">Setup</h2>
        <p className="text-sm text-muted-foreground">
          What Oat may use on this Mac. Run setup again to change a permission or try a test
          recording.
        </p>
      </div>
      {rows ? (
        <Card size="sm">
          <CardContent className="flex flex-col gap-3">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
              {rows.map(([label, view]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd
                    className={cn(
                      'text-right text-muted-foreground',
                      view === 'done' && 'text-success',
                      view === 'blocked' && 'text-destructive',
                    )}
                    data-testid={`setup-${label.toLowerCase().replace(' ', '-')}`}
                    data-state={view}
                  >
                    {LABEL[view]}
                  </dd>
                </div>
              ))}
            </dl>
            <Button
              variant="outline"
              className="self-start"
              onClick={onOpenSetup}
              data-testid="open-setup"
            >
              Open setup
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Skeleton className="h-32 w-full" role="status" aria-busy aria-label="Loading" />
      )}
    </div>
  );
}
