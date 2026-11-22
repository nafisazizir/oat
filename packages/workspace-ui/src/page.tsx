import { NoteColumn } from '@oat/meeting-ui';
import { cn } from '@oat/ui';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@oat/ui/components/empty';

/** An icon component (Tabler, or any component that takes a `className`). */
export type PageIcon = React.ComponentType<{ className?: string }>;

/** Centered content column used by every app page (the note measure, `--content-width`). */
export function PageContainer({ className, ...props }: React.ComponentProps<'div'>) {
  return <NoteColumn className={className} {...props} />;
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
        <div className="flex items-center gap-2 text-label-13 text-gray-900">{eyebrow}</div>
      )}
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-heading-32 text-gray-1000">{title}</h1>
        {children}
      </div>
      {description && <p className="text-copy-16 text-gray-900">{description}</p>}
    </header>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-label-13 text-gray-900">{children}</h2>;
}

/** "Nothing here yet": ziiz `Empty` with an icon, a title, one line of help and optional actions. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
  titleAs: Title = 'h3',
}: {
  icon: PageIcon;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** `h1` when the empty state is the whole page (not found, link unavailable): every page has an h1. */
  titleAs?: 'h1' | 'h2' | 'h3';
}) {
  return (
    <Empty className={cn('border border-dashed border-gray-alpha-400', className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="text-gray-900" />
        </EmptyMedia>
        <Title data-slot="empty-title" className="text-heading-20 text-gray-1000">
          {title}
        </Title>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && (
        <EmptyContent className="flex-row flex-wrap justify-center">{children}</EmptyContent>
      )}
    </Empty>
  );
}
