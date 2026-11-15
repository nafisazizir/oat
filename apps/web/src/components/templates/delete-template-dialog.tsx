'use client';

import { Button } from '@oat/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@oat/ui/components/dialog';
import { Loader2Icon } from 'lucide-react';
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            It disappears for everyone in this workspace. Notes already enhanced with it stay as
            they are.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
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
            {pending && <Loader2Icon className="animate-spin" />}
            Delete template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
