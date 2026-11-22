import { Button } from '@oat/ui/components/button';
import type { CalendarEvent, ConferenceProvider } from '@oat/core';
import { IconAlertCircle, type Icon as TablerIcon } from '@tabler/icons-react';
import Link from 'next/link';

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

const listClass = 'flex flex-col overflow-hidden';

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="upcoming"
      className="flex flex-col gap-2 rounded-lg border border-gray-alpha-400 bg-background-200 p-3"
    >
      <h2 id="upcoming" className="flex h-8 items-center px-2.5 text-label-12 text-gray-900">
        Coming up
      </h2>
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
      className="flex flex-col gap-3 px-0 py-2 sm:min-h-14 sm:flex-row sm:items-center"
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
    variant="secondary"
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

  if (!connected) return null;
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
  if (events.length === 0) return null;
  return (
    <Section>
      {events.length > 0 && (
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
  return null;
}
