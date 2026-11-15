/**
 * Under a meeting note's title (7.3): the calendar event it was made from — when it is scheduled and its
 * Zoom / Meet / Teams link — while the calendar still has the event.
 */
import type { NoteCalendarEvent } from '@oat/core/bridge';
import { Button } from '@oat/ui/components/button';
import { CalendarIcon, VideoIcon } from 'lucide-react';

import { bridge } from '../bridge.ts';
import { CONFERENCE_LABELS, formatRange } from './calendar-state.ts';

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export function NoteEventLine({ event }: { event: NoteCalendarEvent | null }) {
  if (!event) return null;
  const label = event.conferenceProvider ? CONFERENCE_LABELS[event.conferenceProvider] : null;
  return (
    <p
      className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
      data-testid="note-calendar-event"
    >
      <CalendarIcon aria-hidden className="size-3.5" />
      <span>
        Scheduled {DAY.format(new Date(event.start))} · {formatRange(event.start, event.end)}
      </span>
      {event.conferenceUrl && (
        <Button
          variant="outline"
          size="sm"
          className="ml-1 h-6 px-2 text-xs"
          onClick={() => bridge().send('shell:open-external', { url: event.conferenceUrl! })}
        >
          <VideoIcon data-icon="inline-start" />
          Join{label ? ` ${label}` : ''}
        </Button>
      )}
    </p>
  );
}
