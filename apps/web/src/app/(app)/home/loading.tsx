import { Skeleton } from '@oat/ui/components/skeleton';

import { UpcomingMeetingsSkeleton } from '@/components/calendar/upcoming-meetings';
import { PageContainer } from '@/components/page';

function DocumentListSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-xl border border-gray-alpha-400">
      {Array.from({ length: count }, (_, row) => (
        <div key={row} className="flex items-center gap-3.5 border border-transparent px-4 py-3">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="ms-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export default function HomeLoading() {
  return (
    // Same frame as `HomeLayout`: the 32px title row starts 4px under the shell header.
    <PageContainer
      role="status"
      aria-busy="true"
      aria-label="Loading home"
      className="max-w-[744px] gap-8 pt-1 pb-8 sm:pt-1 sm:pb-8"
    >
      <div className="flex h-8 items-center px-2">
        <Skeleton className="h-5 w-28" />
      </div>
      <UpcomingMeetingsSkeleton />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-28" />
        <DocumentListSkeleton count={5} />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-24" />
        <DocumentListSkeleton count={4} />
      </div>
    </PageContainer>
  );
}
