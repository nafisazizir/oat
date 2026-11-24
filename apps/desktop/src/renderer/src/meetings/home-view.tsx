import type { CalendarSnapshot } from '@oat/core/bridge';
import { HomeDocuments } from '@oat/workspace-ui/home-documents';
import { HomeLayout, useWorkspaceHost } from '@oat/workspace-ui';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Button } from '@oat/ui/components/button';
import { useContext } from 'react';
import { DesktopHomeData } from '../workspace/home-data';
import { UpcomingList } from '../calendar/upcoming-list.tsx';

export function HomeView({
  calendar,
  onOpen,
  recordingMeetingId,
  otherWorkspace,
}: {
  calendar: CalendarSnapshot | null;
  onOpen(id: string): void;
  recordingMeetingId: string | null;
  otherWorkspace(id: string): string | null;
}) {
  const home = useContext(DesktopHomeData);
  const host = useWorkspaceHost();
  return (
    <HomeLayout data-testid="desktop-home">
      <UpcomingList snapshot={calendar} onOpen={onOpen} otherWorkspace={otherWorkspace} />
      {home.loading && (
        <div role="status" aria-label="Loading notes" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-12" />
          <div>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-11 items-center gap-3 px-2">
                <Skeleton className="size-4" />
                <Skeleton className="h-5 w-44" />
                <Skeleton className="ms-auto h-4 w-14" />
              </div>
            ))}
          </div>
        </div>
      )}
      {home.error && (
        <div role="alert" className="flex flex-col items-start gap-2 text-copy-14 text-gray-900">
          <p>{home.error}</p>
          <Button variant="outline" onClick={home.retry}>
            Try again
          </Button>
        </div>
      )}
      {(!home.loading || home.documents.length > 0) && (
        <HomeDocuments
          documents={home.documents}
          recordingMeetingId={recordingMeetingId}
          emptyMessage={home.error ? 'No saved or pending notes on this device.' : undefined}
          onOpen={(id) =>
            host.navigate({
              view: 'document',
              id,
              ...(home.documents.find((doc) => doc.id === id)?.kind === 'meeting'
                ? { query: { kind: 'meeting' } }
                : {}),
            })
          }
        />
      )}
    </HomeLayout>
  );
}
