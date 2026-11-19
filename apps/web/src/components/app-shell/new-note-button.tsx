'use client';

import { Button } from '@oat/ui/components/button';
import { IconEdit } from '@tabler/icons-react';

import { useTreeActions } from './tree-actions';
import { useNewNote } from './use-new-note';

export function NewNoteButton(props: Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  const newNote = useNewNote();
  const { canCreate } = useTreeActions();
  // Viewers can't create anything in this workspace.
  if (!canCreate) return null;
  return (
    <Button onClick={newNote} {...props}>
      <IconEdit data-icon="inline-start" />
      New note
    </Button>
  );
}
