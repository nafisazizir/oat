import { cn } from '@oat/ui';

/** "oat." with the brand full stop (same mark as apps/web and the @oat/ui gallery). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-heading-20 text-gray-1000', className)}>
      oat<span className="text-brand-900">.</span>
    </span>
  );
}
