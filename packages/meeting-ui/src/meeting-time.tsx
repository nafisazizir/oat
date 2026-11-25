'use client';

/**
 * When the meeting was recorded, under its title: "Yesterday, 3:04 PM", with "Live" before it while it is
 * being recorded. Nothing when it was never recorded (a calendar note shows its slot instead). With `events`
 * it is a button that links the note to a calendar event (`MeetingEventPicker`).
 */
import { IconCalendar } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { type EventPickerProps, MeetingEventPicker } from './event-picker.tsx';
import { meetingWhen } from './format.ts';
import { MeetingLive, MetaItem } from './meeting-meta.tsx';

export function MeetingTime({
  startedAt,
  endedAt,
  live = false,
  timeZone,
  className,
  events,
}: {
  startedAt: string | null;
  endedAt: string | null;
  /** Being recorded right now (the desktop knows; the web infers it from a missing end). */
  live?: boolean;
  /** `undefined` = the viewer's zone. */
  timeZone?: string;
  className?: string;
  /** Editors: the time opens a menu to link the note to a calendar event around then. */
  events?: EventPickerProps;
}) {
  const [now, setNow] = useState(() => Date.now());
  const when = meetingWhen(startedAt, live ? null : endedAt, now, timeZone);
  const ticking = live || when.inProgress;
  useEffect(() => {
    // Keeps "Today" and the in-progress cap current.
    const timer = setInterval(() => setNow(Date.now()), ticking ? 30_000 : 300_000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!when.label) return null;
  return (
    <>
      {ticking && <MeetingLive />}
      {events ? (
        <MeetingEventPicker
          {...events}
          timeZone={timeZone}
          data-testid="meeting-time"
          data-in-progress={ticking || undefined}
        >
          <IconCalendar aria-hidden />
          <time dateTime={startedAt ?? undefined}>{when.label}</time>
        </MeetingEventPicker>
      ) : (
        <MetaItem
          className={className}
          data-testid="meeting-time"
          data-in-progress={ticking || undefined}
        >
          <IconCalendar aria-hidden />
          <time dateTime={startedAt ?? undefined}>{when.label}</time>
        </MetaItem>
      )}
    </>
  );
}
