import { Skeleton } from '@oat/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FeaturePageHeader } from '@oat/feature-ui';

import { PageContainer } from '@/components/page';
import { SearchView } from '@/components/search/search-view';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Search' };

/** `/search?q=&tab=notes|transcripts`: full-text search over the active workspace (task 3.6). */
export default async function SearchPage() {
  const { workspace } = await getShellData();
  return (
    <PageContainer className="gap-8">
      <FeaturePageHeader kind="search" workspaceName={workspace.name} />
      {/* `useSearchParams` needs a boundary; the view takes over from the URL on the client. */}
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <SearchView />
      </Suspense>
    </PageContainer>
  );
}
