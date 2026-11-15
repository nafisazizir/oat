/**
 * Sidebar "Upcoming" (7.3): today's and tomorrow's meetings from the Mac's calendars and Google Calendar.
 * Clicking one makes its meeting note (title, attendees, the event) — or reopens the one already made — and
 * opens it; recording starts from the note (or from the "Start notes?" prompt). When no calendar can be read,
 * a "Connect" call to action; nothing ever asks for access on its own.
 */
import type { CalendarSnapshot, UpcomingEvent } from '@oat/core/bridge';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { CalendarPlusIcon, Loader2Icon, NotebookPenIcon, VideoIcon } from 'lucide-react';
import { useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { CONFERENCE_LABELS, formatTime, groupByDay } from './calendar-state.ts';

export function UpcomingList({
  snapshot,
  onOpen,
}: {
  snapshot: CalendarSnapshot | null;
  onOpen: (documentId: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  if (!snapshot) return null;
  const now = new Date();
  const groups = groupByDay(snapshot.events, now);
  const cta = connectAction(snapshot);

  async function start(event: UpcomingEvent) {
    if (pending) return;
    setPending(event.id);
    setError(null);
    try {
      const result = await call('calendar:start-notes', { eventId: event.id });
      onOpen(result.documentId);
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Couldn’t start notes.');
    } finally {
      setPending(null);
    }
  }

  async function connect(provider: 'eventkit' | 'google') {
    setConnecting(true);
    setError(null);
    try {
      await call('calendar:connect', { provider });
    } catch (e) {
      setError(e instanceof BridgeCallError ? e.message : 'Couldn’t connect the calendar.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section
      aria-labelledby="upcoming-heading"
      className="flex flex-col gap-1"
      data-testid="upcoming"
    >
      <h2 id="upcoming-heading" className="px-2.5 pt-1 text-xs font-medium text-muted-foreground">
        Upcoming
      </h2>
      {groups.length === 0 ? (
        !cta && (
          <p className="px-2.5 text-xs text-muted-foreground" data-testid="upcoming-empty">
            No more meetings today or tomorrow.
          </p>
        )
      ) : (
        <div className="-mx-1 flex max-h-56 flex-col gap-1 overflow-y-auto px-1">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col">
              <h3 className="px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </h3>
              <ul className="flex flex-col gap-px">
                {group.events.map((event) => (
                  <li key={event.id}>
                    <UpcomingRow
                      event={event}
                      now={now}
                      pending={pending === event.id}
                      onStart={() => void start(event)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {cta && (
        <div
          className="mx-1 flex flex-col gap-2 rounded-lg border border-dashed px-2.5 py-2"
          data-testid="calendar-connect"
        >
          <p className="text-xs text-muted-foreground">{cta.text}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 justify-start"
            disabled={connecting}
            onClick={() => void connect(cta.provider)}
          >
            {connecting ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <CalendarPlusIcon data-icon="inline-start" />
            )}
            {cta.label}
          </Button>
        </div>
      )}
      {error && (
        <p role="status" className="px-2.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function UpcomingRow({
  event,
  now,
  pending,
  onStart,
}: {
  event: UpcomingEvent;
  now: Date;
  pending: boolean;
  onStart: () => void;
}) {
  const title = event.title || 'Untitled event';
  const live = new Date(event.start).getTime() <= now.getTime();
  const hasNote = event.documentId !== null;
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={pending}
      data-testid="upcoming-event"
      data-event-id={event.id}
      data-has-note={hasNote || undefined}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-fast outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70',
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
        style={event.calendarColor ? { backgroundColor: event.calendarColor } : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        {/* The action is part of the name, before the visible text (WCAG 2.5.3: label in name). */}
        <span className="sr-only">{hasNote ? 'Open notes for ' : 'Start notes for '}</span>
        <span className="truncate" data-testid="upcoming-event-title">
          {title}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          {formatTime(event.start)}
          {event.conferenceProvider && (
            <>
              <span aria-hidden>·</span>
              <VideoIcon aria-hidden className="size-3" />
              <span className="truncate">{CONFERENCE_LABELS[event.conferenceProvider]}</span>
            </>
          )}
        </span>
      </span>
      {live && (
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[11px]">
          Now
        </Badge>
      )}
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-opacity duration-fast',
          !pending &&
            !hasNote &&
            'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <NotebookPenIcon className={cn('size-3.5', hasNote && 'text-primary')} />
        )}
      </span>
    </button>
  );
}

/** What to offer when a calendar can't be read (never prompts by itself: the user clicks). */
function connectAction(
  s: CalendarSnapshot,
): { provider: 'eventkit' | 'google'; label: string; text: string } | null {
  if (s.eventkit === 'not_determined') {
    return {
      provider: 'eventkit',
      label: 'Connect calendar',
      text: 'See your meetings here and start notes from them in one click.',
    };
  }
  if (s.eventkit === 'denied' || s.eventkit === 'restricted' || s.eventkit === 'write_only') {
    return {
      provider: 'eventkit',
      label: 'Open System Settings',
      text: 'Oat can’t read your calendars. Allow it under Privacy & Security → Calendars.',
    };
  }
  if (s.eventkit !== 'full_access' && s.google === 'not_connected') {
    return {
      provider: 'google',
      label: 'Connect Google Calendar',
      text: 'Connect a calendar to see upcoming meetings and start notes from them.',
    };
  }
  if (s.google === 'reconnect' && s.eventkit !== 'full_access') {
    return {
      provider: 'google',
      label: 'Reconnect Google Calendar',
      text: 'Oat can’t read your Google Calendar any more.',
    };
  }
  return null;
}
