import { getPipelineSettings } from '@oat/services/pipeline';
import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Badge } from '@oat/ui/components/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import { Skeleton } from '@oat/ui/components/skeleton';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBrandNotion,
  IconCalendar,
  IconCircleCheck,
} from '@tabler/icons-react';
import type { Metadata } from 'next';
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
import { BackLink, PageContainer, PageHeader } from '@/components/page';
import { PipelineSwitch, PipelineSwitchSkeleton } from '@/components/pipeline/pipeline-settings';
import { SettingsList, SettingsSection } from '@/components/settings/section';
import type { NotionConnectionInfo } from '@/lib/api-types';
import { calendarConnectErrorMessage } from '@/lib/calendar-errors';
import { integrationModes, serverEnv } from '@/lib/env';
import { formatDate } from '@/lib/format';
import { notionConnectErrorMessage } from '@/lib/notion-client';
import { loadActor } from '@/server/actor';
import { notionDeps } from '@/server/api';
import { getGoogleCalendarConnection } from '@/server/calendar';
import { getNotionConnection } from '@/server/notion';
import { requireSession } from '@/server/session';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Integrations' };

const AUTO_ENHANCE_LABEL = 'Auto-enhance after meetings';
const NOTION_TITLE = 'Notion';
const NOTION_DESCRIPTION =
  'Send notes to a Notion page or database and keep them up to date. Oat only sees the pages you share with it.';

function ErrorAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert variant="destructive">
      <IconAlertCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function SuccessAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert role="status">
      <IconCircleCheck />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Square tile for an integration's icon, the same size as the avatar column in other settings lists. */
function IntegrationIcon({ children }: { children: React.ReactNode }) {
  return (
    <ItemMedia className="flex size-8 items-center justify-center rounded-md border border-gray-alpha-400 text-gray-1000 [&_svg]:size-4">
      {children}
    </ItemMedia>
  );
}

function DevNote({ children }: { children: React.ReactNode }) {
  return <p className="text-copy-13 text-gray-900">{children}</p>;
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; notion_error?: string }>;
}) {
  const session = await requireSession();
  const [params, connection, shell] = await Promise.all([
    searchParams,
    getGoogleCalendarConnection(session.user.id),
    getShellData(),
  ]);
  const mode = integrationModes(serverEnv()).calendar;
  const error = calendarConnectErrorMessage(params.error);
  const justConnected = params.connected === 'google-calendar' && connection !== null && !error;
  const needsReconnect = connection !== null && !connection.hasCalendarScope;

  return (
    <PageContainer className="gap-10">
      <PageHeader
        title="Integrations"
        description="Connect the tools Oat works alongside."
        eyebrow={<BackLink href="/settings">Settings</BackLink>}
      />

      <SettingsSection
        title="After a meeting"
        description={`When a meeting you recorded in ${shell.workspace.name} ends, Oat finishes the notes in the background.`}
        data-testid="after-meetings-card"
      >
        <Suspense fallback={<PipelineSwitchSkeleton label={AUTO_ENHANCE_LABEL} />}>
          <AfterMeetingsSwitch userId={session.user.id} workspaceId={shell.workspace.id} />
        </Suspense>
      </SettingsSection>

      <SettingsSection
        title="Google Calendar"
        description="Upcoming meetings on Home, one click to start notes. Read-only: Oat never changes your calendar."
        action={
          <Badge
            variant={connection ? 'secondary' : 'outline'}
            data-testid="google-calendar-status"
          >
            {connection ? 'Connected' : 'Not connected'}
          </Badge>
        }
      >
        {error && <ErrorAlert>{error}</ErrorAlert>}
        {justConnected && (
          <SuccessAlert>
            Google Calendar is connected. Your next meetings now show on Home.
          </SuccessAlert>
        )}
        <SettingsList>
          <Item className="flex-wrap">
            <IntegrationIcon>
              <IconCalendar />
            </IntegrationIcon>
            {connection ? (
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle className="w-full min-w-0">
                  <span className="truncate" data-testid="google-calendar-account">
                    {connection.email ?? 'Google account'}
                  </span>
                </ItemTitle>
                <ItemDescription className="text-copy-13">
                  {needsReconnect
                    ? 'Calendar access wasn’t granted. Connect again and allow it.'
                    : `Connected ${formatDate(connection.connectedAt)}`}
                </ItemDescription>
              </ItemContent>
            ) : (
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle>Not connected</ItemTitle>
                <ItemDescription className="text-copy-13">
                  Choose a Google account and allow read-only calendar access.
                </ItemDescription>
              </ItemContent>
            )}
            <ItemActions>
              {connection ? (
                <>
                  {needsReconnect && <ConnectGoogleCalendarButton label="Connect again" />}
                  <DisconnectGoogleCalendarButton />
                </>
              ) : (
                <ConnectGoogleCalendarButton />
              )}
            </ItemActions>
          </Item>
        </SettingsList>
        {mode === 'mock' && (
          <DevNote>Development: Google sign-in and the Calendar API are local mocks.</DevNote>
        )}
      </SettingsSection>

      {/* Its own boundary: Notion's lookups never hold up the rest of the page. */}
      <Suspense fallback={<NotionSkeleton />}>
        <NotionSection
          userId={session.user.id}
          connected={params.connected === 'notion'}
          error={notionConnectErrorMessage(params.notion_error)}
        />
      </Suspense>
    </PageContainer>
  );
}

/** The post-meeting pipeline (8.3): what happens on its own when a meeting ends, for the active workspace. */
async function AfterMeetingsSwitch({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}) {
  const notion = notionDeps();
  const actor = await loadActor(notion.db, userId);
  const settings = await getPipelineSettings(notion.db, actor, workspaceId);
  return (
    <PipelineSwitch
      workspaceId={workspaceId}
      setting="autoEnhance"
      initial={settings.autoEnhance}
      label={AUTO_ENHANCE_LABEL}
      description={{
        on: 'Notes are enhanced with the meeting’s template (or the default one).',
        off: 'Notes stay as you wrote them until you press Enhance.',
      }}
    />
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
  const [connection, settings] = notion.config
    ? await Promise.all([
        getNotionConnection(notion, actor, shell.workspace.id),
        getPipelineSettings(notion.db, actor, shell.workspace.id),
      ])
    : [null, null];
  return (
    <NotionCard
      autoSend={settings?.autoSendToNotion ?? null}
      configured={notion.config !== null}
      mock={notion.config?.mode === 'mock'}
      workspace={shell.workspace}
      connection={connection}
      justConnected={connected && connection !== null}
      error={error}
    />
  );
}

/** Notion while it loads: the header and the not-connected row, with the dynamic text skeletoned. */
function NotionSkeleton() {
  return (
    <SettingsSection
      title={NOTION_TITLE}
      description={NOTION_DESCRIPTION}
      action={<Skeleton className="h-5 w-24 rounded-full" />}
      aria-busy
    >
      <SettingsList>
        <Item className="flex-wrap">
          <IntegrationIcon>
            <IconBrandNotion />
          </IntegrationIcon>
          <ItemContent className="min-w-0 gap-0">
            <span className="text-label-14">
              <Skeleton className="h-lh w-28" />
            </span>
            <span className="text-copy-13">
              <Skeleton className="h-lh w-56" />
            </span>
          </ItemContent>
          <ItemActions>
            <Skeleton className="h-8 w-24 rounded-md" />
          </ItemActions>
        </Item>
      </SettingsList>
    </SettingsSection>
  );
}

/**
 * Notion (8.1): connect per Oat workspace (the active one), choose where notes go, disconnect. Sending a note
 * happens on the note itself ("Send to Notion").
 */
function NotionCard({
  autoSend,
  configured,
  mock,
  workspace,
  connection,
  justConnected,
  error,
}: {
  /** "Auto-send meeting notes to Notion" (8.3); null without a connection. */
  autoSend: boolean | null;
  configured: boolean;
  mock: boolean;
  workspace: { id: string; name: string };
  connection: NotionConnectionInfo | null;
  justConnected: boolean;
  error: string | null;
}) {
  const reconnect = connection?.needsReconnect === true;
  const emoji =
    connection?.notionWorkspaceIcon && !connection.notionWorkspaceIcon.startsWith('http')
      ? connection.notionWorkspaceIcon
      : null;
  return (
    <SettingsSection
      title={NOTION_TITLE}
      description={NOTION_DESCRIPTION}
      data-testid="notion-card"
      action={
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
      }
    >
      {error && <ErrorAlert>{error}</ErrorAlert>}
      {justConnected && !error && (
        <SuccessAlert>Notion is connected. Choose where your notes should go.</SuccessAlert>
      )}
      {reconnect && (
        <ErrorAlert>
          Oat can no longer reach this Notion workspace (access was removed). Connect again to keep
          sending notes.
        </ErrorAlert>
      )}

      <SettingsList>
        <Item className="flex-wrap">
          <IntegrationIcon>
            {emoji ? (
              <span aria-hidden className="text-heading-16">
                {emoji}
              </span>
            ) : (
              <IconBrandNotion />
            )}
          </IntegrationIcon>
          {!configured ? (
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle>Not available</ItemTitle>
              <ItemDescription className="text-copy-13">
                Notion isn’t set up on this server yet.
              </ItemDescription>
            </ItemContent>
          ) : connection ? (
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="w-full min-w-0">
                <span className="truncate" data-testid="notion-workspace">
                  {connection.notionWorkspaceName ?? 'Notion workspace'}
                </span>
              </ItemTitle>
              <ItemDescription className="text-copy-13">
                For {workspace.name} · connected {formatDate(connection.connectedAt)}
              </ItemDescription>
            </ItemContent>
          ) : (
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle>Not connected</ItemTitle>
              <ItemDescription className="text-copy-13">
                For {workspace.name}. Notion asks which pages to share with Oat.
              </ItemDescription>
            </ItemContent>
          )}
          {configured && (
            <ItemActions>
              {connection ? (
                <>
                  {reconnect && (
                    <ConnectNotionButton workspaceId={workspace.id} label="Reconnect" />
                  )}
                  <DisconnectNotionButton workspaceId={workspace.id} />
                </>
              ) : (
                <ConnectNotionButton workspaceId={workspace.id} />
              )}
            </ItemActions>
          )}
        </Item>
      </SettingsList>

      {connection && !reconnect && (
        <>
          <NotionTargetPicker workspaceId={workspace.id} target={connection.target} />
          {autoSend !== null && (
            <PipelineSwitch
              workspaceId={workspace.id}
              setting="autoSendToNotion"
              initial={autoSend}
              label="Auto-send meeting notes to Notion"
              description={{
                on: 'When a meeting ends, its notes go to the page or database above.',
                off: 'Send notes yourself with “Send to Notion” on the note.',
              }}
            />
          )}
          {connection.target?.url && (
            <a
              href={connection.target.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 rounded-sm text-label-13 text-gray-900 underline-offset-4 transition-colors duration-fast outline-none hover:text-gray-1000 hover:underline focus-visible:ring-3 focus-visible:ring-gray-600/50"
            >
              Open “{connection.target.title || 'Untitled'}” in Notion
              <IconArrowUpRight className="size-3.5" />
            </a>
          )}
        </>
      )}

      {configured && mock && (
        <DevNote>Development: Notion is a local mock; consent is approved automatically.</DevNote>
      )}
    </SettingsSection>
  );
}
