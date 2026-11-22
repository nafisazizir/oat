import type { CalendarSnapshot } from '@oat/core/bridge';
import { HomeDocuments } from '@oat/workspace-ui/home-documents';
import { useWorkspaceHost } from '@oat/workspace-ui';
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
    <div
      className="mx-auto flex w-full max-w-[744px] flex-col gap-8 px-8 py-8"
      data-testid="desktop-home"
    >
      <UpcomingList snapshot={calendar} onOpen={onOpen} otherWorkspace={otherWorkspace} compact />
      {home.loading && (
        <p role="status" className="text-copy-14 text-gray-900">
          Loading notes…
        </p>
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
    </div>
  );
}
