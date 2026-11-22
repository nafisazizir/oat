import type { CalendarSnapshot, MeetingNoteSummary } from '@oat/core/bridge';
import { groupNotesByDate } from '@oat/meeting-ui';
import { EmptyState, HomeLayout } from '@oat/workspace-ui';
import { Skeleton } from '@oat/ui/components/skeleton';
import { IconNotes } from '@tabler/icons-react';
import { useState } from 'react';

import { UpcomingList } from '../calendar/upcoming-list.tsx';

export function HomeView({
  notes,
  calendar,
  onOpen,
  recordingMeetingId,
  otherWorkspace,
}: {
  notes: MeetingNoteSummary[] | null;
  calendar: CalendarSnapshot | null;
  onOpen: (id: string) => void;
  recordingMeetingId: string | null;
  otherWorkspace: (id: string) => string | null;
}) {
  const [now] = useState(() => Date.now());
  const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
  return (
    <HomeLayout data-testid="desktop-home">
      <UpcomingList snapshot={calendar} onOpen={onOpen} otherWorkspace={otherWorkspace} compact />
      {notes === null ? (
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
      ) : notes.length === 0 ? (
        <EmptyState
          icon={IconNotes}
          title="No notes yet"
          description="Create a note or start a meeting to capture what matters."
        />
      ) : (
        groupNotesByDate(notes, (note) => note.startedAt ?? note.createdAt, now).map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
            <h2 className="px-2 text-label-12 text-gray-900">{group.label}</h2>
            <ul>
              {group.notes.map((note) => (
                <li key={note.documentId}>
                  <button
                    type="button"
                    onClick={() => onOpen(note.documentId)}
                    data-testid="home-note-row"
                    className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2.5 text-start text-copy-14 text-gray-1000 outline-none transition-colors hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50"
                  >
                    <IconNotes aria-hidden className="size-4 shrink-0 text-gray-900" />
                    <span className="min-w-0 flex-1 truncate">
                      {note.title || 'Untitled meeting'}
                    </span>
                    {recordingMeetingId && recordingMeetingId === note.meetingId && (
                      <span className="text-label-12 text-red-900">Recording</span>
                    )}
                    <time
                      dateTime={note.startedAt ?? note.createdAt}
                      className="shrink-0 text-label-12 text-gray-900"
                    >
                      {time.format(new Date(note.startedAt ?? note.createdAt))}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </HomeLayout>
  );
}
