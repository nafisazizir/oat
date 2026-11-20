import type { ComponentProps } from 'react';
import { cn } from '@oat/ui/lib/utils';

export const TRANSCRIPT_PANEL_SIZE = { default: 360, min: 280, max: 600 } as const;

export function NoteColumn({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-content flex-col gap-10 px-6 py-10 sm:px-8 sm:py-14',
        className,
      )}
      {...props}
    />
  );
}
