/**
 * Settings → Recording (7.5): when Oat stops recording by itself. Per Mac (`autostop:get-settings` /
 * `autostop:set-settings`, `<userData>/auto-stop.json`). A switch flips at once; a failed save puts it back.
 */
import type { AutoStopSettingsSnapshot } from '@oat/core/bridge';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@oat/ui/components/field';
import { SettingsHeading } from '@oat/settings-ui';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Switch } from '@oat/ui/components/switch';
import { useEffect, useId, useRef, useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';

const SWITCHES = [
  {
    key: 'enabled',
    label: 'Stop recording automatically when the meeting ends',
    description:
      'When the call app lets go of the microphone at the end of its calendar event, Oat stops after 10 seconds — with a chance to keep recording. Otherwise it asks.',
    testId: 'autostop-enabled',
  },
  {
    key: 'inPerson',
    label: 'Also stop in-person recordings',
    description:
      'Recordings without a call app stop after 10 minutes of silence. When off, Oat only asks.',
    testId: 'autostop-in-person',
  },
] as const;

export function RecordingSettings() {
  const [settings, setSettings] = useState<AutoStopSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The last state main confirmed: where a failed save rolls back to. */
  const confirmed = useRef<AutoStopSettingsSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    void call('autostop:get-settings')
      .then((s) => {
        if (!live) return;
        confirmed.current = s;
        setSettings(s);
      })
      .catch(() => live && setError('Couldn’t load the recording settings.'));
    return () => {
      live = false;
    };
  }, []);

  const save = (patch: Partial<AutoStopSettingsSnapshot>) => {
    setError(null);
    setSettings((s) => (s ? { ...s, ...patch } : s));
    void call('autostop:set-settings', patch)
      .then((saved) => {
        confirmed.current = saved;
        setSettings(saved);
      })
      .catch((e: unknown) => {
        setSettings(confirmed.current);
        setError(e instanceof BridgeCallError ? e.message : 'Couldn’t save the setting.');
      });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="recording-settings">
      <SettingsHeading>Recording</SettingsHeading>
      <p role="alert" className="text-copy-14 text-red-900 empty:hidden">
        {error}
      </p>
      {settings || !error ? (
        <FieldGroup className="gap-0">
          {SWITCHES.map((s, i) => (
            <SettingSwitch
              key={s.key}
              label={s.label}
              description={s.description}
              testId={s.testId}
              divided={i > 0}
              checked={
                settings
                  ? s.key === 'enabled'
                    ? settings.enabled
                    : settings.enabled && settings.inPerson
                  : null
              }
              disabled={s.key === 'inPerson' && settings !== null && !settings.enabled}
              onChange={(value) => save({ [s.key]: value })}
            />
          ))}
        </FieldGroup>
      ) : null}
    </div>
  );
}

function SettingSwitch({
  label,
  description,
  checked,
  disabled,
  divided,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  /** `null` while loading: the row keeps its size, a skeleton stands in for the switch. */
  checked: boolean | null;
  disabled: boolean;
  divided: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <Field
      orientation="horizontal"
      className={divided ? 'border-t border-gray-alpha-400 py-3' : 'py-3'}
      data-disabled={disabled || undefined}
    >
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      {checked === null ? (
        <Skeleton className="h-[18.4px] w-8 shrink-0 rounded-full" aria-busy />
      ) : (
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          data-testid={testId}
        />
      )}
    </Field>
  );
}
