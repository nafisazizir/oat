'use client';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@oat/ui/components/field';
import { Switch } from '@oat/ui/components/switch';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { pipelineApi } from '@/lib/api-client';
import type { PipelineSettingsDto, UpdatePipelineSettingsInput } from '@/lib/pipeline';

type Key = 'autoEnhance' | 'autoSendToNotion';

/**
 * One post-meeting switch (8.3) for the user's own settings in a workspace: saved right away through
 * `PUT /api/settings/pipeline`, rolled back with a toast if that fails.
 */
export function PipelineSwitch({
  workspaceId,
  setting,
  initial,
  label,
  description,
}: {
  workspaceId: string;
  setting: Key;
  initial: boolean;
  label: string;
  description: { on: string; off: string };
}) {
  const id = useId();
  const [checked, setChecked] = useState(initial);
  const [pending, setPending] = useState(false);

  async function change(next: boolean) {
    setChecked(next);
    setPending(true);
    try {
      const input: UpdatePipelineSettingsInput = { workspaceId, [setting]: next };
      const saved: PipelineSettingsDto = await pipelineApi.updateSettings(input);
      setChecked(saved[setting] === true);
    } catch (error) {
      setChecked(!next);
      toast.error('Couldn’t save that setting', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <FieldLabel htmlFor={id} className="rounded-lg border border-gray-alpha-400">
      <Field orientation="horizontal" className="items-start px-3 py-2.5">
        <FieldContent className="gap-0">
          <FieldTitle>{label}</FieldTitle>
          <FieldDescription className="text-copy-13">
            {checked ? description.on : description.off}
          </FieldDescription>
        </FieldContent>
        <Switch
          id={id}
          data-testid={`pipeline-${setting}`}
          checked={checked}
          disabled={pending}
          onCheckedChange={(next) => void change(next)}
        />
      </Field>
    </FieldLabel>
  );
}
