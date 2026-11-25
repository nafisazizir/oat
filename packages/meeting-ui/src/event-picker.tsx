'use client';

/**
 * Linking a meeting note to a calendar event: the header's date pill opens a small menu of the events
 * around the note's time. Picking one links it (its attendees are added to the note); the linked one is
 * checked and can be unlinked. The caller reads the events and persists (web API).
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCheck, IconUnlink } from '@tabler/icons-react';
import { type ReactNode, useRef, useState } from 'react';

import { scheduleLabel } from './format.ts';
import { metaActionClass } from './meeting-meta.tsx';

export interface LinkableEvent {
  id: string;
  title: string;
  /** ISO. */
  start: string;
  end: string;
}

export interface EventChoices {
  /** Whether a calendar is connected at all. */
  connected: boolean;
  /** `reconnect`: access was lost; `error`: the calendar couldn't be read; `null`: not connected. */
  state: 'ok' | 'reconnect' | 'error' | null;
  /** The note is linked to an event (possibly one outside `events`). */
  linked: boolean;
  linkedEventId: string | null;
  events: readonly LinkableEvent[];
}

export interface EventPickerProps {
  /** Read when the menu opens. */
  load: () => Promise<EventChoices>;
  onLink: (event: LinkableEvent) => Promise<void>;
  onUnlink: () => Promise<void>;
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function MeetingEventPicker({
  load,
  onLink,
  onUnlink,
  children,
  timeZone,
  ...trigger
}: EventPickerProps & {
  /** The pill's content (icon + time). */
  children: ReactNode;
  timeZone?: string;
  'data-testid'?: string;
  'data-in-progress'?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<EventChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // "Today" / "Yesterday" in the rows, as of when the menu opened.
  const [now, setNow] = useState(() => Date.now());
  // Only the newest read counts (the menu can be reopened while one is on its way).
  const request = useRef(0);

  function change(next: boolean) {
    setOpen(next);
    if (!next) return;
    const id = ++request.current;
    setNow(Date.now());
    setError(null);
    load().then(
      (result) => id === request.current && setChoices(result),
      (e: unknown) => {
        if (id !== request.current) return;
        setChoices(null);
        setError(message(e, 'Couldn’t load your calendar.'));
      },
    );
  }

  async function run(key: string, action: () => Promise<void>, fallback: string) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(null);
    }
  }

  const hint = !choices
    ? null
    : !choices.connected
      ? 'Connect a calendar in Settings to link events.'
      : choices.state === 'reconnect'
        ? 'Reconnect your calendar in Settings to link events.'
        : choices.state === 'error'
          ? 'Couldn’t read your calendar. Try again later.'
          : choices.events.length === 0
            ? 'No calendar events around this time.'
            : null;

  return (
    <DropdownMenu size="sm" open={open} onOpenChange={change}>
      <DropdownMenuTrigger className={metaActionClass} aria-label="Calendar event" {...trigger}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Calendar event" className="w-80" data-testid="event-picker">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Link a calendar event</DropdownMenuLabel>
          {!choices && !error && (
            <DropdownMenuItem disabled>
              <Spinner />
              Loading…
            </DropdownMenuItem>
          )}
          {hint && (
            <p className="px-2 py-1 text-label-13 text-gray-900" data-testid="event-picker-hint">
              {hint}
            </p>
          )}
          {choices?.events.map((event) => {
            const linked = event.id === choices.linkedEventId;
            return (
              <DropdownMenuItem
                key={event.id}
                closeOnClick={false}
                disabled={busy !== null}
                data-testid="event-option"
                data-linked={linked || undefined}
                aria-current={linked || undefined}
                onClick={() => {
                  if (!linked) void run(event.id, () => onLink(event), 'Couldn’t link the event.');
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{event.title || 'Untitled event'}</span>
                  <span className="truncate text-label-12 text-gray-900">
                    {scheduleLabel(event.start, event.end, false, now, timeZone)}
                  </span>
                </span>
                {busy === event.id ? (
                  <Spinner />
                ) : (
                  linked && <IconCheck aria-label="Linked" className="text-gray-900" />
                )}
              </DropdownMenuItem>
            );
          })}
          {choices?.linked && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                closeOnClick={false}
                disabled={busy !== null}
                data-testid="event-unlink"
                onClick={() => void run('unlink', onUnlink, 'Couldn’t remove the link.')}
              >
                {busy === 'unlink' ? <Spinner /> : <IconUnlink />}
                Remove event link
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuGroup>
        {error && (
          <p role="alert" className="px-2 py-1 text-label-13 text-red-900">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
