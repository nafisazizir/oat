'use client';

import { Button } from '@oat/ui/components/button';
import { SquarePenIcon } from 'lucide-react';

import { useNewNote } from './use-new-note';

export function NewNoteButton(props: Omit<React.ComponentProps<typeof Button>, 'onClick'>) {
  const newNote = useNewNote();
  return (
    <Button onClick={newNote} {...props}>
      <SquarePenIcon data-icon="inline-start" />
      New note
    </Button>
  );
}
