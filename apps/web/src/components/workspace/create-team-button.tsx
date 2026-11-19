'use client';

import { Button } from '@oat/ui/components/button';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';

import { CreateWorkspaceDialog } from '@/components/app-shell/create-workspace-dialog';

/** Opens the existing "Create a team workspace" dialog (it switches to the new workspace). */
export function CreateTeamButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <IconPlus data-icon="inline-start" />
        Create a team workspace
      </Button>
      <CreateWorkspaceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
