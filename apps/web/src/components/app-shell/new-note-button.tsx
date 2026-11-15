'use client';

import { Button } from '@oat/ui/components/button';
import { SquarePenIcon } from 'lucide-react';

import { useTreeActions } from './tree-actions';
import { useNewNote } from './use-new-note';

export function NewNoteButton(props: Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  const newNote = useNewNote();
  const { canCreate } = useTreeActions();
  // Viewers can't create anything in this workspace.
  if (!canCreate) return null;
  return (
    <Button onClick={newNote} {...props}>
      <SquarePenIcon data-icon="inline-start" />
      New note
    </Button>
  );
}
