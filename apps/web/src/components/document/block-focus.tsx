'use client';

import { BlockFocus as EditorBlockFocus } from '@oat/editor/react';
import { useSearchParams } from 'next/navigation';

export function BlockFocus() {
  return <EditorBlockFocus blockId={useSearchParams().get('block')} />;
}
