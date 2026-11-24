/**
 * Home → "Coming up" (7.3): today's and tomorrow's meetings from the Mac's calendars and Google Calendar, a
 * row per day with the date beside it. Clicking a meeting makes its note (title, attendees, the event) — or
 * reopens the one already made — and opens it; recording starts from the note (or from the "Start notes?"
 * prompt). When no calendar can be read, a "Connect" call to action; nothing ever asks for access on its
 * own. With a readable calendar and nothing scheduled, today's row says so. A note made in another
 * workspace than the active one says which (3.9); new notes go to the active workspace (or, as a viewer
 * there, the first one I can add notes to).
 */
import type { CalendarSnapshot, UpcomingEvent } from '@oat/core/bridge';
import { useWorkspaceHost } from '@oat/workspace-ui';
import { ComingUp, ComingUpDay, ComingUpNotice, startOfDay } from '@oat/workspace-ui/coming-up';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCalendarOff, IconCalendarPlus, IconNotes, IconVideo } from '@tabler/icons-react';
import { useState } from 'react';

import { BridgeCallError, call } from '../bridge.ts';
import { CONFERENCE_LABELS, formatRange, groupByDay } from './calendar-state.ts';

export function UpcomingList({
  snapshot,
  onOpen,
  otherWorkspace,
}: {
  snapshot: CalendarSnapshot | null;
  onOpen: (documentId: string) => void;
  /** 3.9: the name of the workspace a note lives in when it isn't the one the sidebar shows. */
  otherWorkspace?: (documentId: string) => string | null;
}) {
  const host = useWorkspaceHost();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  if (!snapshot) return null;
  const now = new Date();
  const groups = groupByDay(snapshot.events, now);
  const cta = connectAction(snapshot);
  const readable = snapshot.eventkit === 'full_access' || snapshot.google === 'ok';
  // Nothing to show and nothing to offer (signed out, still loading, calendars off).
  if (groups.length === 0 && !cta && !readable) return null;

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
    if (provider === 'google') {
      host.navigate({ view: 'settings', section: 'integrations' });
      return;
    }
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

  const notice = cta ? (
    <ComingUpNotice
      icon={IconCalendarPlus}
      title={cta.title}
      description={cta.text}
      data-testid="calendar-connect"
      action={
        <Button
          variant="secondary"
          size="sm"
          disabled={connecting}
          onClick={() => void connect(cta.provider)}
        >
          {connecting && <Spinner data-icon="inline-start" />}
          {cta.label}
        </Button>
      }
    />
  ) : (
    <ComingUpNotice
      icon={IconCalendarOff}
      title="Nothing coming up"
      description="No more meetings today or tomorrow."
      data-testid="upcoming-empty"
      action={
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            host.navigate({
              view: 'settings',
              section: snapshot.eventkit === 'full_access' ? 'setup' : 'integrations',
            })
          }
        >
          Calendar settings
        </Button>
      }
    />
  );

  return (
    <ComingUp headingId="upcoming-heading" data-testid="upcoming">
      {groups.map((group, index) => (
        <ComingUpDay
          key={group.label}
          date={group.date}
          today={group.label === 'Today'}
          relative={group.label}
        >
          <ul className="flex flex-col gap-px">
            {group.events.map((event) => (
              <li key={event.id}>
                <UpcomingRow
                  event={event}
                  workspace={event.documentId ? (otherWorkspace?.(event.documentId) ?? null) : null}
                  now={now}
                  pending={pending === event.id}
                  onStart={() => void start(event)}
                />
              </li>
            ))}
          </ul>
          {/* A calendar that still needs connecting, under the meetings the other one has. */}
          {cta && index === groups.length - 1 && <div className="mt-2 flex">{notice}</div>}
        </ComingUpDay>
      ))}
      {groups.length === 0 && (
        <ComingUpDay date={startOfDay(now)} today relative="Today">
          {notice}
        </ComingUpDay>
      )}
      {error && (
        <p role="status" className="px-5 py-3 text-copy-13 text-red-900">
          {error}
        </p>
      )}
    </ComingUp>
  );
}

function UpcomingRow({
  event,
  workspace,
  now,
  pending,
  onStart,
}: {
  event: UpcomingEvent;
  workspace: string | null;
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
        'group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start transition-colors outline-none hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 active:bg-gray-alpha-200 disabled:cursor-progress',
      )}
    >
      <span
        aria-hidden
        className="w-0.5 shrink-0 self-stretch rounded-full bg-gray-500"
        style={event.calendarColor ? { backgroundColor: event.calendarColor } : undefined}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        {/* The action is part of the name, before the visible text (WCAG 2.5.3: label in name). */}
        <span className="sr-only">{hasNote ? 'Open notes for ' : 'Start notes for '}</span>
        <span className="truncate text-label-14 text-gray-1000" data-testid="upcoming-event-title">
          {title}
        </span>
        <span className="flex items-center gap-1 text-label-12 text-gray-900 tabular-nums">
          {formatRange(event.start, event.end)}
          {event.conferenceProvider && (
            <>
              <span aria-hidden>·</span>
              <IconVideo aria-hidden className="size-3" />
              <span className="truncate">{CONFERENCE_LABELS[event.conferenceProvider]}</span>
            </>
          )}
          {workspace && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate" data-testid="upcoming-event-workspace">
                in {workspace}
              </span>
            </>
          )}
        </span>
      </span>
      {live && (
        <Badge variant="secondary" className="shrink-0">
          Now
        </Badge>
      )}
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center text-gray-900 transition-opacity',
          !pending &&
            !hasNote &&
            'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      >
        {pending ? (
          <Spinner className="size-3.5" aria-hidden />
        ) : (
          <IconNotes className={cn('size-3.5', hasNote && 'text-brand-900')} />
        )}
      </span>
    </button>
  );
}

/** What to offer when a calendar can't be read (never prompts by itself: the user clicks). */
function connectAction(
  s: CalendarSnapshot,
): { provider: 'eventkit' | 'google'; label: string; title: string; text: string } | null {
  if (s.eventkit === 'not_determined') {
    return {
      provider: 'eventkit',
      label: 'Connect calendar',
      title: 'No calendar connected',
      text: 'See your meetings here and start notes from them in one click.',
    };
  }
  if (s.eventkit === 'denied' || s.eventkit === 'restricted' || s.eventkit === 'write_only') {
    return {
      provider: 'eventkit',
      label: 'Open System Settings',
      title: 'Calendar access is off',
      text: 'Oat can’t read your calendars. Allow it under Privacy & Security → Calendars.',
    };
  }
  if (s.eventkit !== 'full_access' && s.google === 'not_connected') {
    return {
      provider: 'google',
      label: 'Connect Google Calendar',
      title: 'No calendar connected',
      text: 'Connect a calendar to see upcoming meetings and start notes from them.',
    };
  }
  if (s.google === 'reconnect' && s.eventkit !== 'full_access') {
    return {
      provider: 'google',
      label: 'Reconnect Google Calendar',
      title: 'Google Calendar needs reconnecting',
      text: 'Oat can’t read your Google Calendar any more.',
    };
  }
  return null;
}
