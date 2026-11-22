import { IconChevronLeft } from '@tabler/icons-react';
import type { Route } from 'next';
import Link from 'next/link';

/** "‹ Settings": the one way a sub-page links back to its parent (eyebrow above the title). */
export function BackLink({ href, children }: { href: Route; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="-ms-1 inline-flex min-h-6 w-fit items-center gap-0.5 rounded-sm pe-1 text-label-13 text-gray-900 transition-colors hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
    >
      <IconChevronLeft className="size-3.5" aria-hidden />
      {children}
    </Link>
  );
}

export {
  PageContainer,
  PageHeader,
  SectionHeading,
  EmptyState,
  type PageIcon,
} from '@oat/workspace-ui/page';
