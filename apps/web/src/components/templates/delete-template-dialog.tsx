'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@oat/ui/components/alert-dialog';
import { Spinner } from '@oat/ui/components/spinner';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';

import { templateClient } from './template-client';

export function DeleteTemplateDialog({
  open,
  onOpenChange,
  templateId,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It disappears for everyone in this workspace. Notes already enhanced with it stay as
            they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  await templateClient.remove(templateId);
                  onOpenChange(false);
                  toast.success(`Deleted ${name}`);
                  router.push('/templates');
                  router.refresh();
                } catch (error) {
                  toast.error((error as Error).message);
                }
              })
            }
          >
            {pending && <Spinner data-icon="inline-start" />}
            Delete template
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
