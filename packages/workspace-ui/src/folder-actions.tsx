'use client';

import { Button } from '@oat/ui/components/button';
import { IconFilePlus } from '@tabler/icons-react';

import { useTreeActions } from './tree-actions';

/** Folder page header action: a new page inside this folder. */
export function FolderActions({ folderId }: { folderId: string }) {
  const { newPage } = useTreeActions();
  return (
    <Button variant="outline" onClick={() => void newPage({ folderId })}>
      <IconFilePlus data-icon="inline-start" />
      New page
    </Button>
  );
}
