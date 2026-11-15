import { Skeleton } from '@oat/ui/components/skeleton';
import { LinkIcon } from 'lucide-react';
import type { Metadata } from 'next';

import { PageContainer, PageHeader } from '@/components/page';

export const metadata: Metadata = {
  title: 'Shared note',
  // Shared pages are unlisted.
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ token: string }> };

/** Placeholder for the share viewer (5.4): resolves the token to a read-only document. */
export default async function SharePage({ params }: Props) {
  const { token } = await params;

  return (
    <PageContainer>
      <PageHeader
        title="Shared note"
        eyebrow={
          <>
            <LinkIcon className="size-3.5" />
            <span className="font-mono">{token.slice(0, 12)}</span>
          </>
        }
        description="The read-only viewer for shared notes is coming soon. This page shows its layout."
      />
      <div className="flex flex-col gap-3" aria-hidden>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-4 h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </PageContainer>
  );
}
