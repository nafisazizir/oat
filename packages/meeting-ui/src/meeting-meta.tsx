'use client';

/**
 * The meeting header's facts under the title, all in one style (text, icon, spacing): Private (only when
 * it is), Live, when, the calendar slot and its Join link, attendees, View only / In trash. The workspace,
 * a shared note's audience and the duration are left out on purpose.
 */
import { cn } from '@oat/ui/lib/utils';
import { IconCalendar, IconEye, IconLock, IconTrash, IconVideo } from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';

/** One fact in the meeting header (in a `pill` row, each in the same gray pill). */
export const metaItemClass =
  'inline-flex h-6 shrink-0 items-center gap-1.5 text-label-13 whitespace-nowrap text-gray-900 [&_svg]:size-3.5 [&_svg]:shrink-0 group-data-[look=pill]/meta:rounded-md group-data-[look=pill]/meta:bg-gray-100 group-data-[look=pill]/meta:px-2';

/** A fact that opens or does something: same look, darker on hover/open, focus ring. */
export const metaActionClass = cn(
  metaItemClass,
  'cursor-pointer rounded-md outline-none transition-colors hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 aria-expanded:text-gray-1000 group-data-[look=pill]/meta:hover:bg-gray-200 group-data-[look=pill]/meta:aria-expanded:bg-gray-200',
);

/** `plain`: bare text + icon facts; `pill`: the same facts, each in a gray pill. */
export type MeetingMetaLook = 'plain' | 'pill';

export function MeetingMetaRow({
  look = 'plain',
  className,
  ...props
}: ComponentProps<'div'> & { look?: MeetingMetaLook }) {
  return (
    <div
      className={cn(
        'group/meta flex min-h-6 flex-wrap items-center gap-x-4 gap-y-1 data-[look=pill]:gap-x-1.5 data-[look=pill]:gap-y-1.5',
        className,
      )}
      data-testid="meeting-header"
      data-look={look}
      {...props}
    />
  );
}

export function MetaItem({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn(metaItemClass, className)} {...props} />;
}

/** Only a private note says so; a shared one shows nothing (it is the default in a workspace). */
export function MeetingPrivate({ visibility }: { visibility: string }) {
  if (visibility !== 'private') return null;
  return (
    <MetaItem data-testid="meeting-private">
      <IconLock aria-hidden />
      Private
    </MetaItem>
  );
}

export function MeetingLive() {
  return (
    <MetaItem className="text-red-900" data-testid="meeting-live">
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-red-700" />
      Live
    </MetaItem>
  );
}

export function MeetingAccess({ state }: { state: 'edit' | 'view' | 'trash' }) {
  if (state === 'edit') return null;
  return (
    <MetaItem data-testid="meeting-access">
      {state === 'trash' ? <IconTrash aria-hidden /> : <IconEye aria-hidden />}
      {state === 'trash' ? 'In trash' : 'View only'}
    </MetaItem>
  );
}

/**
 * The calendar event the note was made from: its slot while nothing is recorded yet (afterwards the
 * recorded time says when), and its call link until the event is over.
 */
export function MeetingEventMeta({
  schedule,
  showSchedule,
  joinLabel,
  joinHref,
  onJoin,
}: {
  /** "Today, 4:00 – 4:30 PM"; null while unknown (e.g. before hydration on the web). */
  schedule: string | null;
  showSchedule: boolean;
  /** "Join Zoom"; null = no call link or the event is over. */
  joinLabel: string | null;
  joinHref?: string;
  onJoin?: () => void;
}): ReactNode {
  if (!(showSchedule && schedule) && !joinLabel) return null;
  return (
    <span className="contents" data-testid="note-calendar-event">
      {showSchedule && schedule && (
        <MetaItem>
          <IconCalendar aria-hidden />
          {schedule}
        </MetaItem>
      )}
      {joinLabel && (
        <a
          className={metaActionClass}
          href={joinHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={
            onJoin
              ? (event) => {
                  event.preventDefault();
                  onJoin();
                }
              : undefined
          }
        >
          <IconVideo aria-hidden />
          {joinLabel}
        </a>
      )}
    </span>
  );
}
