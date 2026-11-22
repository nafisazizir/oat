import type { ComponentProps } from 'react';

import { cn } from '@oat/ui/lib/utils';

export function AuthPanel({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-6', className)} {...props} />;
}

export function AuthHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 text-center', className)} {...props} />;
}

export function AuthTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-heading-24 text-gray-1000', className)} {...props} />;
}

export function AuthDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-copy-14 text-gray-900', className)} {...props} />;
}

export function AuthContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-3', className)} {...props} />;
}

export function AuthFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2', className)} {...props} />;
}
