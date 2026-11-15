import { cn } from '@oat/ui';
import type { LucideIcon } from 'lucide-react';

/** Centered content column used by every app page (the note measure, `--content-width`). */
export function PageContainer({ className, ...props }: React.ComponentProps<'div'>) {
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

export function PageHeader({
  title,
  description,
  eyebrow,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {eyebrow && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">{eyebrow}</div>
      )}
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-3xl font-medium">{title}</h1>
        {children}
      </div>
      {description && <p className="text-base text-muted-foreground">{description}</p>}
    </header>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/** Dashed "nothing here yet" panel: icon, title, one line of help, optional actions. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children && (
        <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </div>
  );
}
