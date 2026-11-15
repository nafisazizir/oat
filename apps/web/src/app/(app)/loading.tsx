import { Skeleton } from '@oat/ui/components/skeleton';

import { PageContainer } from '@/components/page';

/** Generic app-page skeleton (header + a list), shown while a route segment loads. */
export default function AppLoading() {
  return (
    <PageContainer role="status" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-72" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </PageContainer>
  );
}
