import { Badge } from '@oat/ui/components/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@oat/ui/components/card';
import { ArrowLeftIcon, CalendarDaysIcon, CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ConnectGoogleCalendarButton,
  DisconnectGoogleCalendarButton,
} from '@/components/calendar/google-calendar-actions';
import { PageContainer, PageHeader } from '@/components/page';
import { calendarConnectErrorMessage } from '@/lib/calendar-errors';
import { integrationModes, serverEnv } from '@/lib/env';
import { getGoogleCalendarConnection } from '@/server/calendar';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'Integrations' };

const connectedOn = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const session = await requireSession();
  const [params, connection] = await Promise.all([
    searchParams,
    getGoogleCalendarConnection(session.user.id),
  ]);
  const mode = integrationModes(serverEnv()).calendar;
  const error = calendarConnectErrorMessage(params.error);
  const justConnected = params.connected === 'google-calendar' && connection !== null && !error;
  const needsReconnect = connection !== null && !connection.hasCalendarScope;

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Connect the tools Oat works alongside."
        eyebrow={
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 rounded-sm transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowLeftIcon className="size-3" />
            Settings
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDaysIcon className="size-4 text-muted-foreground" />
            Google Calendar
          </CardTitle>
          <CardDescription>
            See your upcoming meetings on Home and start notes from them. Oat only reads your
            calendar; it never changes it.
          </CardDescription>
          <CardAction>
            <Badge
              variant={connection ? 'secondary' : 'outline'}
              data-testid="google-calendar-status"
            >
              {connection ? 'Connected' : 'Not connected'}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}
          {justConnected && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border bg-muted px-3 py-2 text-sm"
            >
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              Google Calendar is connected. Your next meetings now show on Home.
            </p>
          )}

          {connection ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium" data-testid="google-calendar-account">
                  {connection.email ?? 'Google account'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {needsReconnect
                    ? 'Calendar access wasn’t granted. Connect again and allow it.'
                    : `Read-only access · connected ${connectedOn.format(connection.connectedAt)}`}
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                {needsReconnect && <ConnectGoogleCalendarButton label="Connect again" />}
                <DisconnectGoogleCalendarButton />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                You’ll be asked to choose your Google account and allow read-only calendar access.
              </p>
              <ConnectGoogleCalendarButton className="shrink-0" />
            </div>
          )}

          {mode === 'mock' && (
            <p className="text-xs text-muted-foreground">
              Development: Google sign-in and the Calendar API are local mocks with a sample week of
              meetings.
            </p>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
