'use client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconNotes, IconVideo } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { useShellData } from '@/components/app-shell/shell-data';
import { ApiRequestError, request } from '@/lib/api-client';
import { useHydrated } from '@/lib/use-hydrated';

/** What a row needs (plain JSON from the server component). */
export interface UpcomingMeetingView {
  id: string;
  title: string;
  start: string;
  end: string;
  calendarTitle: string;
  calendarColor: string | null;
  people: number;
  conferenceUrl: string | null;
  conferenceLabel: string | null;
  /** Already started (as of the server render). */
  inProgress: boolean;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * "Start notes" (7.3): the meeting note for this event — made from it (title, attendees) or the one already
 * made for the same meeting — in the current workspace, then opened. The server reads the event itself.
 */
function useStartNotes(eventId: string) {
  const router = useRouter();
  const { workspace } = useShellData();
  const [pending, setPending] = useState(false);
  const canCreate = workspace.role !== 'viewer';
  async function start() {
    if (pending) return;
    setPending(true);
    try {
      const { documentId } = await request<{ documentId: string; created: boolean }>(
        'POST',
        '/api/calendar/notes',
        { eventId, workspaceId: workspace.id },
      );
      router.push(`/d/${documentId}`);
      router.refresh();
    } catch (error) {
      toast.error('Couldn’t start notes', {
        description:
          error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.',
      });
      setPending(false);
    }
  }
  return { start, pending, canCreate };
}

export function UpcomingMeetingRow({ meeting }: { meeting: UpcomingMeetingView }) {
  // False while hydrating: times are formatted in the viewer's own zone, on the client only.
  const isClient = useHydrated();
  const notes = useStartNotes(meeting.id);
  const start = new Date(meeting.start);
  const end = new Date(meeting.end);
  const meta = [
    meeting.calendarTitle,
    meeting.people > 0 ? `${meeting.people} ${meeting.people === 1 ? 'person' : 'people'}` : null,
    meeting.conferenceLabel,
  ].filter(Boolean);

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap"
      data-testid="upcoming-meeting"
    >
      <time
        dateTime={meeting.start}
        className="flex h-8 w-32 shrink-0 flex-col text-label-13 whitespace-nowrap text-gray-900 tabular-nums"
      >
        {isClient ? (
          <>
            <span className="text-gray-1000">{dayFormat.format(start)}</span>
            <span>
              {timeFormat.format(start)} – {timeFormat.format(end)}
            </span>
          </>
        ) : null}
      </time>
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {meeting.calendarColor && (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: meeting.calendarColor }}
            />
          )}
          <span
            className="truncate text-label-14 text-gray-1000"
            data-testid="upcoming-meeting-title"
          >
            {meeting.title || 'Untitled event'}
          </span>
          {meeting.inProgress && <Badge variant="secondary">Now</Badge>}
        </div>
        <span className="truncate text-copy-13 text-gray-900">{meta.join(' · ')}</span>
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {meeting.conferenceUrl && (
          <Button
            variant="outline"
            size="sm"
            role="link"
            nativeButton={false}
            render={
              <a
                href={meeting.conferenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Join ${meeting.title || 'meeting'}${meeting.conferenceLabel ? ` on ${meeting.conferenceLabel}` : ''}`}
              />
            }
          >
            <IconVideo data-icon="inline-start" />
            Join
          </Button>
        )}
        {notes.canCreate && (
          <Button
            variant="ghost"
            size="sm"
            disabled={notes.pending || !isClient}
            aria-label={`Start notes for ${meeting.title || 'this meeting'}`}
            onClick={() => void notes.start()}
          >
            {notes.pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <IconNotes data-icon="inline-start" />
            )}
            Start notes
          </Button>
        )}
      </div>
    </div>
  );
}
