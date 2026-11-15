import { Skeleton } from '@oat/ui/components/skeleton';

import { PageContainer } from '@/components/page';

/** Document skeleton: eyebrow, title, then paragraph lines at the note measure. */
export default function DocumentLoading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading page">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-9 w-2/3" />
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
