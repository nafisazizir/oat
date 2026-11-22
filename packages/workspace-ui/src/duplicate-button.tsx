'use client';

import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCopy } from '@tabler/icons-react';
import { useWorkspaceHost } from './host';
import { useTransition } from 'react';
import { toast } from 'sonner';

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
  const host = useWorkspaceHost();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const { template } = await host.client.templates.duplicate({
              workspaceId,
              fromTemplateId: templateId,
            });
            toast.success(`Created ${template.name}`);
            host.navigate({ view: 'template', id: template.id });
            host.refresh();
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
