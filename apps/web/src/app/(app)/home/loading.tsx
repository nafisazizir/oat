import { Skeleton } from '@oat/ui/components/skeleton';

import { PageContainer } from '@/components/page';

/** Home skeleton: header, the recent-notes panel and a few page rows. */
export default function HomeLoading() {
  return (
    <PageContainer aria-busy="true" aria-label="Loading home">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-5 w-64" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-11 w-full" />
        ))}
      </div>
    </PageContainer>
  );
}
