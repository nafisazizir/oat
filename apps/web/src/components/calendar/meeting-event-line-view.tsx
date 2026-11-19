'use client';

import { Button } from '@oat/ui/components/button';
import { IconCalendar, IconVideo } from '@tabler/icons-react';

import { formatTimeRange } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';

const dayFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/**
 * The note's calendar line (see `MeetingEventLine`). Times are in the viewer's own zone, so they are only
 * written once hydrated (the server doesn't know the zone); the Join link works from the first paint.
 */
export function MeetingEventLineView({
  start,
  end,
  allDay,
  conferenceUrl,
  conferenceLabel,
}: {
  start: string;
  end: string;
  allDay: boolean;
  conferenceUrl: string | null;
  conferenceLabel: string | null;
}) {
  const hydrated = useHydrated();
  const from = new Date(start);
  return (
    <p
      className="flex flex-wrap items-center gap-1.5 text-copy-14 text-gray-900"
      data-testid="note-calendar-event"
    >
      <IconCalendar aria-hidden className="size-4" />
      <span>Scheduled</span>
      {/* Same separators as the meeting's own time line above it (`MeetingTime`). */}
      {hydrated && (
        <time dateTime={start} className="inline-flex flex-wrap gap-1.5">
          <span>{dayFormat.format(from)}</span>
          <span aria-hidden>·</span>
          <span>{allDay ? 'All day' : formatTimeRange(from, new Date(end))}</span>
        </time>
      )}
      {conferenceUrl && (
        <Button
          variant="outline"
          size="xs"
          className="ms-1"
          role="link"
          nativeButton={false}
          render={<a href={conferenceUrl} target="_blank" rel="noopener noreferrer" />}
        >
          <IconVideo data-icon="inline-start" />
          Join{conferenceLabel ? ` ${conferenceLabel}` : ''}
        </Button>
      )}
    </p>
  );
}
