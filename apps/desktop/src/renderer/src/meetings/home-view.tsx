import type { CalendarSnapshot, MeetingNoteSummary } from '@oat/core/bridge';
import { groupNotesByDate } from '@oat/meeting-ui';
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
    <div
      className="mx-auto flex w-full max-w-[744px] flex-col gap-8 px-8 py-8"
      data-testid="desktop-home"
    >
      <UpcomingList snapshot={calendar} onOpen={onOpen} otherWorkspace={otherWorkspace} compact />
      {notes === null ? (
        <p role="status" className="text-copy-14 text-gray-900">
          Loading notes…
        </p>
      ) : notes.length === 0 ? (
        <p className="py-8 text-copy-14 text-gray-900">No notes yet</p>
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
    </div>
  );
}
