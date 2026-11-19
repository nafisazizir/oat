import { Button } from '@oat/ui/components/button';
import { Skeleton } from '@oat/ui/components/skeleton';
import type { CalendarEvent, ConferenceProvider } from '@oat/core';
import { IconAlertCircle, IconCalendarEvent, type Icon as TablerIcon } from '@tabler/icons-react';
import Link from 'next/link';

import { SectionHeading } from '@/components/page';
import { listUpcomingMeetings } from '@/server/calendar';
import { requireSession } from '@/server/session';

import { UpcomingMeetingRow, type UpcomingMeetingView } from './upcoming-meeting-row';

export const CONFERENCE_LABELS: Record<ConferenceProvider, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
};

function toView(event: CalendarEvent, now: Date): UpcomingMeetingView {
  return {
    id: event.id,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    calendarTitle: event.calendar.title,
    calendarColor: event.calendar.color,
    people: event.attendees.length,
    conferenceUrl: event.conferenceUrl,
    conferenceLabel: event.conferenceProvider ? CONFERENCE_LABELS[event.conferenceProvider] : null,
    inProgress: event.start.getTime() <= now.getTime(),
  };
}

const listClass =
  'flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-xl border border-gray-alpha-400';

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="upcoming" className="flex flex-col gap-3">
      <SectionHeading>
        <span id="upcoming">Upcoming</span>
      </SectionHeading>
      {children}
    </section>
  );
}

/** One-line panel for the not-connected / needs-attention states. */
function Notice({
  icon: Icon,
  children,
  action,
  testId,
}: {
  icon: TablerIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-dashed border-gray-alpha-400 px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 text-copy-14 text-gray-900">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}

const settingsLink = (label: string) => (
  <Button
    variant="outline"
    size="sm"
    role="link"
    nativeButton={false}
    render={<Link href="/settings/integrations" />}
    className="shrink-0 self-start sm:self-auto"
  >
    {label}
  </Button>
);

/** Home → "Upcoming": the next few meetings from the user's connected calendars. */
export async function UpcomingMeetings() {
  const session = await requireSession();
  const now = new Date();
  const { connected, sources, events } = await listUpcomingMeetings(session.user.id, { now });
  const state = sources[0]?.state;

  if (!connected) {
    return (
      <Section>
        <Notice
          icon={IconCalendarEvent}
          testId="upcoming-connect"
          action={settingsLink('Connect Google Calendar')}
        >
          Connect your calendar to see upcoming meetings here and join them in one click.
        </Notice>
      </Section>
    );
  }
  if (state === 'reconnect') {
    return (
      <Section>
        <Notice
          icon={IconAlertCircle}
          testId="upcoming-reconnect"
          action={settingsLink('Reconnect')}
        >
          Oat can’t read your Google Calendar any more. Connect it again to see your meetings.
        </Notice>
      </Section>
    );
  }
  if (state === 'error') {
    return (
      <Section>
        <Notice icon={IconAlertCircle} testId="upcoming-error">
          Your calendar couldn’t be loaded right now. It will try again next time you open Home.
        </Notice>
      </Section>
    );
  }
  return (
    <Section>
      {events.length === 0 ? (
        <Notice icon={IconCalendarEvent} testId="upcoming-empty">
          No meetings in the next two weeks.
        </Notice>
      ) : (
        <ul className={listClass} data-testid="upcoming-meetings">
          {events.map((event) => (
            <li key={event.id}>
              <UpcomingMeetingRow meeting={toView(event, now)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function UpcomingMeetingsSkeleton() {
  return (
    <Section>
      <div className={listClass} role="status" aria-label="Loading meetings">
        {/* Mirrors UpcomingMeetingRow box for box. */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap"
          >
            <div className="flex h-8 w-32 shrink-0 flex-col justify-center gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
              <div className="flex h-5 items-center">
                <Skeleton className="h-3.5 w-1/2" />
              </div>
              <div className="flex h-[18px] items-center">
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
            <Skeleton className="ms-auto h-8 w-28 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </Section>
  );
}
