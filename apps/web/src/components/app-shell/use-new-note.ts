'use client';

import { useCallback } from 'react';

import { useTreeActions } from './tree-actions';

/** "New note": a new meeting note at the top level of Private, opened right away. */
export function useNewNote() {
  const { newPage } = useTreeActions();
  return useCallback(() => void newPage({ kind: 'meeting', area: 'private' }), [newPage]);
}
