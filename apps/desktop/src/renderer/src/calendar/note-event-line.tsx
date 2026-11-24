/**
 * Under a meeting note's title (7.3): the calendar event it was made from — its slot while nothing is
 * recorded yet, and its Zoom / Meet / Teams link until the event is over — while the calendar still has it.
 */
import type { NoteCalendarEvent } from '@oat/core/bridge';
import { MeetingEventMeta, scheduleLabel } from '@oat/meeting-ui';
import { useEffect, useState } from 'react';

import { bridge } from '../bridge.ts';
import { CONFERENCE_LABELS } from './calendar-state.ts';

export function NoteEventLine({
  event,
  recorded,
}: {
  event: NoteCalendarEvent | null;
  /** Something is recorded: the recorded time replaces the slot. */
  recorded: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!event) return null;
  const label = event.conferenceProvider ? CONFERENCE_LABELS[event.conferenceProvider] : null;
  const joinable = event.conferenceUrl && Date.parse(event.end) > now;
  return (
    <MeetingEventMeta
      schedule={scheduleLabel(event.start, event.end, false, now)}
      showSchedule={!recorded}
      joinLabel={joinable ? `Join${label ? ` ${label}` : ''}` : null}
      joinHref={event.conferenceUrl ?? undefined}
      onJoin={() => bridge().send('shell:open-external', { url: event.conferenceUrl! })}
    />
  );
}
