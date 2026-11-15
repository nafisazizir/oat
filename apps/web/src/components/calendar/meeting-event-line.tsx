import { loadMeetingCalendarEvent } from '@/server/shell';

import { MeetingEventLineView } from './meeting-event-line-view';
import { CONFERENCE_LABELS } from './upcoming-meetings';

/**
 * Under a meeting note's title on the web (7.3 follow-up, 9.3): the calendar event the note was started from,
 * "Scheduled Mon, Nov 16 · 9:30 – 9:45 AM · Join Google Meet", read from the user's own connected calendar
 * while it still has the event. Rendered inside `<Suspense>`: a slow calendar never holds up the note.
 */
export async function MeetingEventLine({ documentId }: { documentId: string }) {
  const event = await loadMeetingCalendarEvent(documentId);
  if (!event) return null;
  return (
    <MeetingEventLineView
      start={event.start.toISOString()}
      end={event.end.toISOString()}
      allDay={event.allDay}
      conferenceUrl={event.conferenceUrl}
      conferenceLabel={
        event.conferenceProvider ? CONFERENCE_LABELS[event.conferenceProvider] : null
      }
    />
  );
}
