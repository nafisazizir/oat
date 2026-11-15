import { Button } from '@oat/ui/components/button';
import { Skeleton } from '@oat/ui/components/skeleton';
import type { CalendarEvent, ConferenceProvider } from '@oat/core';
import { CalendarDaysIcon, CircleAlertIcon } from 'lucide-react';
import Link from 'next/link';

import { SectionHeading } from '@/components/page';
import { listUpcomingMeetings } from '@/server/calendar';
import { requireSession } from '@/server/session';

import { UpcomingMeetingRow, type UpcomingMeetingView } from './upcoming-meeting-row';

const CONFERENCE_LABELS: Record<ConferenceProvider, string> = {
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
  icon: typeof CalendarDaysIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-dashed px-4 py-4 sm:flex-row sm:items-center"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span>{children}</span>
      </div>
      {action}
    </div>
  );
}

const settingsLink = (label: string) => (
  <Button variant="outline" size="sm" asChild className="shrink-0 self-start sm:self-auto">
    <Link href="/settings/integrations">{label}</Link>
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
          icon={CalendarDaysIcon}
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
          icon={CircleAlertIcon}
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
        <Notice icon={CircleAlertIcon} testId="upcoming-error">
          Your calendar couldn’t be loaded right now. It will try again next time you open Home.
        </Notice>
      </Section>
    );
  }
  return (
    <Section>
      {events.length === 0 ? (
        <Notice icon={CalendarDaysIcon} testId="upcoming-empty">
          No meetings in the next two weeks.
        </Notice>
      ) : (
        <ul
          className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
          data-testid="upcoming-meetings"
        >
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
      <div className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-8 w-32" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
