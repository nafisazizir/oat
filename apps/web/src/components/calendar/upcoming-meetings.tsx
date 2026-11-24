import { Button } from '@oat/ui/components/button';
import type { CalendarEvent, ConferenceProvider } from '@oat/core';
import { ComingUp, ComingUpNotice } from '@oat/workspace-ui/coming-up';
import { IconAlertCircle, IconCalendarOff } from '@tabler/icons-react';
import Link from 'next/link';

import { listUpcomingMeetings } from '@/server/calendar';
import { requireSession } from '@/server/session';

import {
  UpcomingMeetingDays,
  UpcomingToday,
  type UpcomingMeetingView,
} from './upcoming-meeting-row';

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

function Section({ children }: { children: React.ReactNode }) {
  return <ComingUp headingId="upcoming">{children}</ComingUp>;
}

const settingsLink = (label: string) => (
  <Button
    variant="secondary"
    size="sm"
    role="link"
    nativeButton={false}
    render={<Link href="/settings/integrations" />}
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

  if (!connected) return null;
  if (state === 'reconnect') {
    return (
      <Section>
        <UpcomingToday>
          <ComingUpNotice
            icon={IconAlertCircle}
            title="Google Calendar needs reconnecting"
            description="Oat can’t read your Google Calendar any more. Connect it again to see your meetings."
            action={settingsLink('Reconnect')}
            data-testid="upcoming-reconnect"
          />
        </UpcomingToday>
      </Section>
    );
  }
  if (state === 'error') {
    return (
      <Section>
        <UpcomingToday>
          <ComingUpNotice
            icon={IconAlertCircle}
            title="Your calendar couldn’t be loaded"
            description="It will try again next time you open Home."
            data-testid="upcoming-error"
          />
        </UpcomingToday>
      </Section>
    );
  }
  if (events.length === 0) {
    return (
      <Section>
        <UpcomingToday>
          <ComingUpNotice
            icon={IconCalendarOff}
            title="Nothing coming up"
            description="No meetings on your calendar in the next two weeks."
            action={settingsLink('Calendar settings')}
            data-testid="upcoming-empty"
          />
        </UpcomingToday>
      </Section>
    );
  }
  return (
    <Section>
      <UpcomingMeetingDays meetings={events.map((event) => toView(event, now))} />
    </Section>
  );
}

export function UpcomingMeetingsSkeleton() {
  return null;
}
