'use client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconNotes, IconVideo } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ComingUpDay, startOfDay } from '@oat/workspace-ui/coming-up';
import { useShellData } from '@oat/workspace-ui/shell-data';
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

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

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
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-2.5 py-1.5 sm:flex-nowrap"
      data-testid="upcoming-meeting"
    >
      <span
        aria-hidden
        className="w-0.5 shrink-0 self-stretch rounded-full bg-gray-500"
        style={meeting.calendarColor ? { backgroundColor: meeting.calendarColor } : undefined}
      />
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-label-14 text-gray-1000"
            data-testid="upcoming-meeting-title"
          >
            {meeting.title || 'Untitled event'}
          </span>
          {meeting.inProgress && <Badge variant="secondary">Now</Badge>}
        </div>
        <span className="flex min-w-0 items-center gap-1 text-copy-13 text-gray-900">
          <time dateTime={meeting.start} className="shrink-0 whitespace-nowrap tabular-nums">
            {isClient ? `${timeFormat.format(start)} – ${timeFormat.format(end)}` : null}
          </time>
          {isClient && meta.length > 0 && <span aria-hidden>·</span>}
          <span className="truncate">{meta.join(' · ')}</span>
        </span>
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

/**
 * The meetings as a row per day. Days are the viewer's own (local dates), so they're only known on the
 * client: until hydration everything sits in one row with the date column left blank.
 */
export function UpcomingMeetingDays({ meetings }: { meetings: UpcomingMeetingView[] }) {
  const isClient = useHydrated();
  const list = (items: UpcomingMeetingView[]) => (
    <ul className="flex flex-col gap-px" data-testid="upcoming-meetings">
      {items.map((meeting) => (
        <li key={meeting.id}>
          <UpcomingMeetingRow meeting={meeting} />
        </li>
      ))}
    </ul>
  );
  if (!isClient) return <ComingUpDay date={null}>{list(meetings)}</ComingUpDay>;

  const today = startOfDay(new Date()).getTime();
  const days = new Map<number, UpcomingMeetingView[]>();
  for (const meeting of meetings) {
    // In progress since yesterday still belongs to today.
    const day = Math.max(today, startOfDay(new Date(meeting.start)).getTime());
    days.set(day, [...(days.get(day) ?? []), meeting]);
  }
  const tomorrow = startOfDay(new Date(today + 36 * 3_600_000)).getTime();
  return [...days].map(([day, items]) => (
    <ComingUpDay
      key={day}
      date={new Date(day)}
      today={day === today}
      relative={day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : undefined}
    >
      {list(items)}
    </ComingUpDay>
  ));
}

/** Today's row (the viewer's today, so dated on the client) around a notice. */
export function UpcomingToday({ children }: { children: React.ReactNode }) {
  const isClient = useHydrated();
  return (
    <ComingUpDay date={isClient ? startOfDay(new Date()) : null} today relative="Today">
      {children}
    </ComingUpDay>
  );
}
