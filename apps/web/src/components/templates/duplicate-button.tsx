'use client';

import { Button } from '@oat/ui/components/button';
import { CopyIcon, Loader2Icon } from 'lucide-react';
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
      {pending ? <Loader2Icon className="animate-spin" /> : <CopyIcon />}
      {label}
    </Button>
  );
}
