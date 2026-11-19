import { Skeleton } from '@oat/ui/components/skeleton';

import { PageContainer } from '@/components/page';

/**
 * Document skeleton, on the editor's geometry: the 32px meta row (badge, "Edited …", actions), the 40px
 * title line, then paragraph lines at the note measure.
 */
export default function DocumentLoading() {
  return (
    <PageContainer className="gap-6" role="status" aria-busy="true" aria-label="Loading page">
      <div className="flex flex-col gap-3">
        <div className="flex h-8 items-center gap-3">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex h-10 items-center">
          <Skeleton className="h-8 w-2/3" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </PageContainer>
  );
}
