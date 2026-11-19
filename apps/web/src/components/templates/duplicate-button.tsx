'use client';

import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCopy } from '@tabler/icons-react';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { templateClient } from './template-client';

/** Copies a template into the workspace as a new custom template and opens it in the editor. */
export function DuplicateButton({
  workspaceId,
  templateId,
  label = 'Duplicate',
  variant = 'default',
}: {
  workspaceId: string;
  templateId: string;
  label?: string;
  variant?: 'default' | 'outline';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const { template } = await templateClient.duplicate(workspaceId, templateId);
            toast.success(`Created ${template.name}`);
            router.push(`/templates/${template.id}` as Route);
            router.refresh();
          } catch (error) {
            toast.error((error as Error).message);
          }
        })
      }
    >
      {pending ? <Spinner data-icon="inline-start" /> : <IconCopy data-icon="inline-start" />}
      {label}
    </Button>
  );
}
