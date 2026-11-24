'use client';

import { MeetingEventMeta, scheduleLabel } from '@oat/meeting-ui';
import { useEffect, useState } from 'react';

import { useHydrated } from '@/lib/use-hydrated';

/**
 * The note's calendar facts (see `MeetingEventLine`), in the meeting header's style. Times are in the
 * viewer's own zone, so the slot is only written once hydrated (the server doesn't know the zone); the Join
 * link (only until the event is over) works from the first paint.
 */
export function MeetingEventLineView({
  start,
  end,
  allDay,
  recorded,
  conferenceUrl,
  conferenceLabel,
}: {
  start: string;
  end: string;
  allDay: boolean;
  /** Something is recorded: the recorded time replaces the slot. */
  recorded: boolean;
  conferenceUrl: string | null;
  conferenceLabel: string | null;
}) {
  const hydrated = useHydrated();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <MeetingEventMeta
      schedule={hydrated ? scheduleLabel(start, end, allDay, now) : null}
      showSchedule={!recorded}
      joinLabel={
        conferenceUrl && Date.parse(end) > now
          ? `Join${conferenceLabel ? ` ${conferenceLabel}` : ''}`
          : null
      }
      joinHref={conferenceUrl ?? undefined}
    />
  );
}
