'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';

/** "New note" placeholder: documents are created once the DB (1.5) and editor (M3) exist. */
export function useNewNote() {
  return useCallback(() => {
    toast('New notes are coming soon', {
      description: 'Creating notes arrives with the editor. For now, explore the pages in Private.',
    });
  }, []);
}
