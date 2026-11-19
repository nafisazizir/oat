import { cn } from '@oat/ui';

/** "oat." with the brand-colored full stop. */
export function Wordmark({ size = 'sm', className }: { size?: 'sm' | 'lg'; className?: string }) {
  return (
    <span
      className={cn(
        size === 'lg' ? 'text-heading-32' : 'text-heading-20',
        'text-gray-1000',
        className,
      )}
    >
      oat<span className="text-brand-700">.</span>
    </span>
  );
}
