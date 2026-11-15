import { Badge } from '@oat/ui/components/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@oat/ui/components/card';
import { Skeleton } from '@oat/ui/components/skeleton';
import {
  ArrowLeftIcon,
  CalendarDaysIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  NotebookTextIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import {
  ConnectGoogleCalendarButton,
  DisconnectGoogleCalendarButton,
} from '@/components/calendar/google-calendar-actions';
import {
  ConnectNotionButton,
  DisconnectNotionButton,
  NotionTargetPicker,
} from '@/components/notion/notion-actions';
import { PageContainer, PageHeader } from '@/components/page';
import type { NotionConnectionInfo } from '@/lib/api-types';
import { calendarConnectErrorMessage } from '@/lib/calendar-errors';
import { integrationModes, serverEnv } from '@/lib/env';
import { notionConnectErrorMessage } from '@/lib/notion-client';
import { loadActor } from '@/server/actor';
import { notionDeps } from '@/server/api';
import { getGoogleCalendarConnection } from '@/server/calendar';
import { getNotionConnection } from '@/server/notion';
import { getShellData } from '@/server/shell';
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
  searchParams: Promise<{ connected?: string; error?: string; notion_error?: string }>;
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

      {/* Its own boundary: Notion's lookups never hold up the rest of the page. */}
      <Suspense fallback={<Skeleton className="h-48 w-full rounded-xl" />}>
        <NotionSection
          userId={session.user.id}
          connected={params.connected === 'notion'}
          error={notionConnectErrorMessage(params.notion_error)}
        />
      </Suspense>
    </PageContainer>
  );
}

async function NotionSection({
  userId,
  connected,
  error,
}: {
  userId: string;
  connected: boolean;
  error: string | null;
}) {
  const notion = notionDeps();
  const [shell, actor] = await Promise.all([getShellData(), loadActor(notion.db, userId)]);
  const connection = notion.config
    ? await getNotionConnection(notion, actor, shell.workspace.id)
    : null;
  return (
    <NotionCard
      configured={notion.config !== null}
      mock={notion.config?.mode === 'mock'}
      workspace={shell.workspace}
      connection={connection}
      justConnected={connected && connection !== null}
      error={error}
    />
  );
}

/**
 * Notion (8.1): connect per Oat workspace (the active one), choose where notes go, disconnect. Sending a note
 * happens on the note itself ("Send to Notion").
 */
function NotionCard({
  configured,
  mock,
  workspace,
  connection,
  justConnected,
  error,
}: {
  configured: boolean;
  mock: boolean;
  workspace: { id: string; name: string };
  connection: NotionConnectionInfo | null;
  justConnected: boolean;
  error: string | null;
}) {
  const reconnect = connection?.needsReconnect === true;
  return (
    <Card data-testid="notion-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NotebookTextIcon className="size-4 text-muted-foreground" />
          Notion
        </CardTitle>
        <CardDescription>
          Send notes to a Notion page or database, and update them there when they change. Oat only
          sees the pages you share with it and never reads anything else.
        </CardDescription>
        <CardAction>
          <Badge
            variant={connection && !reconnect ? 'secondary' : 'outline'}
            data-testid="notion-status"
          >
            {!configured
              ? 'Not available'
              : reconnect
                ? 'Reconnect needed'
                : connection
                  ? 'Connected'
                  : 'Not connected'}
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
        {justConnected && !error && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border bg-muted px-3 py-2 text-sm"
          >
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            Notion is connected. Choose where your notes should go.
          </p>
        )}

        {!configured ? (
          <p className="text-sm text-muted-foreground">Notion isn’t set up on this server yet.</p>
        ) : connection ? (
          <>
            {reconnect && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                Oat can no longer reach this Notion workspace (access was removed). Connect again to
                keep sending notes.
              </p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                {connection.notionWorkspaceIcon &&
                  !connection.notionWorkspaceIcon.startsWith('http') && (
                    <span aria-hidden className="text-lg leading-none">
                      {connection.notionWorkspaceIcon}
                    </span>
                  )}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium" data-testid="notion-workspace">
                    {connection.notionWorkspaceName ?? 'Notion workspace'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    For {workspace.name} · connected{' '}
                    {connectedOn.format(new Date(connection.connectedAt))}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {reconnect && <ConnectNotionButton workspaceId={workspace.id} label="Reconnect" />}
                <DisconnectNotionButton workspaceId={workspace.id} />
              </div>
            </div>
            {!reconnect && (
              <NotionTargetPicker workspaceId={workspace.id} target={connection.target} />
            )}
            {connection.target?.url && !reconnect && (
              <a
                href={connection.target.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Open “{connection.target.title || 'Untitled'}” in Notion
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Connect a Notion workspace for{' '}
              <span className="font-medium text-foreground">{workspace.name}</span>. Notion asks
              which pages to share with Oat.
            </p>
            <ConnectNotionButton workspaceId={workspace.id} />
          </div>
        )}

        {configured && mock && (
          <p className="text-xs text-muted-foreground">
            Development: Notion is a local mock (tools/mocks) with a sample workspace; consent is
            approved automatically.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
