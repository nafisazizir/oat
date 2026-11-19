'use client';

import { Label } from '@oat/ui/components/label';
import { Skeleton } from '@oat/ui/components/skeleton';
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
    <div className={ROW}>
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-copy-13 text-gray-900">
          {checked ? description.on : description.off}
        </span>
      </div>
      <Switch
        id={id}
        data-testid={`pipeline-${setting}`}
        checked={checked}
        disabled={pending}
        onCheckedChange={(next) => void change(next)}
      />
    </div>
  );
}

const ROW =
  'flex items-start justify-between gap-4 rounded-lg border border-gray-alpha-400 px-3 py-2.5';

/** The same row while its setting loads: identical geometry, so nothing moves when it arrives. */
export function PipelineSwitchSkeleton({ label }: { label: string }) {
  return (
    <div className={ROW} aria-hidden>
      <div className="flex flex-col gap-0.5">
        <span className="text-label-14">{label}</span>
        <span className="text-copy-13">
          <Skeleton className="h-lh w-56" />
        </span>
      </div>
      <Skeleton className="h-[18.4px] w-8 shrink-0 rounded-full" />
    </div>
  );
}
