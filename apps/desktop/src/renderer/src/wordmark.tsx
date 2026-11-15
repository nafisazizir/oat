import { cn } from '@oat/ui';

/** "oat." in the heading serif with the ink full stop (same mark as apps/web and the @oat/ui gallery). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-heading text-xl font-semibold tracking-tight', className)}>
      oat<span className="text-primary">.</span>
    </span>
  );
}
