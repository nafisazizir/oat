/**
 * Settings → Recording (7.5): when Oat stops recording by itself. Per Mac (`autostop:get-settings` /
 * `autostop:set-settings`, `<userData>/auto-stop.json`).
 */
import type { AutoStopSettingsSnapshot } from '@oat/core/bridge';
import { Card, CardContent } from '@oat/ui/components/card';
import { Label } from '@oat/ui/components/label';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Switch } from '@oat/ui/components/switch';
import { useEffect, useId, useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';

export function RecordingSettings() {
  const [settings, setSettings] = useState<AutoStopSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call('autostop:get-settings')
      .then((s) => live && setSettings(s))
      .catch(() => live && setError('Couldn’t load the recording settings.'));
    return () => {
      live = false;
    };
  }, []);

  const save = (patch: Partial<AutoStopSettingsSnapshot>) => {
    setError(null);
    setSettings((s) => (s ? { ...s, ...patch } : s)); // optimistic; main answers with what it saved
    void call('autostop:set-settings', patch)
      .then(setSettings)
      .catch((e: unknown) =>
        setError(e instanceof BridgeCallError ? e.message : 'Couldn’t save the setting.'),
      );
  };

  return (
    <div className="flex flex-col gap-5" data-testid="recording-settings">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold">Recording</h2>
        <p className="text-sm text-muted-foreground">
          When your call ends, Oat can stop recording for you. Your notes are then enhanced
          automatically.
        </p>
      </div>
      <p role="alert" className="text-sm text-destructive empty:hidden">
        {error}
      </p>
      {settings ? (
        <Card size="sm">
          <CardContent className="flex flex-col gap-3">
            <SettingSwitch
              label="Stop recording automatically when the meeting ends"
              description="When the call app lets go of the microphone at the end of its calendar event, Oat stops after 10 seconds — with a chance to keep recording. Otherwise it asks."
              checked={settings.enabled}
              onChange={(enabled) => save({ enabled })}
              testId="autostop-enabled"
            />
            <SettingSwitch
              label="Also stop in-person recordings"
              description="Recordings without a call app stop after 10 minutes of silence. When off, Oat only asks."
              checked={settings.enabled && settings.inPerson}
              disabled={!settings.enabled}
              onChange={(inPerson) => save({ inPerson })}
              testId="autostop-in-person"
            />
          </CardContent>
        </Card>
      ) : (
        !error && <Skeleton className="h-36 w-full" aria-busy />
      )}
    </div>
  );
}

function SettingSwitch({
  label,
  description,
  checked,
  disabled = false,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        data-testid={testId}
        className="mt-0.5"
      />
    </div>
  );
}
