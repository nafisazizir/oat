'use client';

import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { NotebookPenIcon, VideoIcon } from 'lucide-react';
import { toast } from 'sonner';

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

export function UpcomingMeetingRow({ meeting }: { meeting: UpcomingMeetingView }) {
  // False while hydrating: times are formatted in the viewer's own zone, on the client only.
  const isClient = useHydrated();
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
        className="flex w-32 shrink-0 flex-col text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {isClient ? (
          <>
            <span className="font-medium text-foreground">{dayFormat.format(start)}</span>
            <span>
              {timeFormat.format(start)} – {timeFormat.format(end)}
            </span>
          </>
        ) : (
          <span aria-hidden className="h-8" />
        )}
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
          <span className="truncate font-medium" data-testid="upcoming-meeting-title">
            {meeting.title || 'Untitled event'}
          </span>
          {meeting.inProgress && <Badge variant="secondary">Now</Badge>}
        </div>
        <span className="truncate text-xs text-muted-foreground">{meta.join(' · ')}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {meeting.conferenceUrl && (
          <Button variant="outline" size="sm" asChild>
            <a
              href={meeting.conferenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Join ${meeting.title || 'meeting'}${meeting.conferenceLabel ? ` on ${meeting.conferenceLabel}` : ''}`}
            >
              <VideoIcon data-icon="inline-start" />
              Join
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            toast('Notes from calendar events are coming soon', {
              description: 'For now, start a new note when the meeting begins.',
            })
          }
        >
          <NotebookPenIcon data-icon="inline-start" />
          Start notes
        </Button>
      </div>
    </div>
  );
}
