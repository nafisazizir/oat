import { Alert, AlertDescription } from '@oat/ui/components/alert';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@oat/ui/components/item';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBrandNotion,
  IconCalendar,
  IconCircleCheck,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState, useTransition, type ReactNode } from 'react';

import { NotionTargetPicker } from './notion-target-picker';
import { PipelineSwitch, PipelineSwitchSkeleton } from './pipeline-settings';
import { SettingsLoadState, useSettingsResource } from './resource';
import { SettingsHeading, SettingsList, SettingsSection } from './section';
import { errorMessage, SettingsProvider, type SettingsServices } from './services';

export type IntegrationNotice = {
  notionError?: string | null;
  calendarError?: string | null;
  connected?: 'notion' | 'google-calendar' | undefined;
};

const AUTO_ENHANCE = 'Auto-enhance after meetings';
const formatDate = (date: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(date));

function Message({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return (
    <Alert variant={error ? 'destructive' : 'default'} role={error ? 'alert' : 'status'}>
      {error ? <IconAlertCircle /> : <IconCircleCheck />}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function IntegrationButton({
  children,
  run,
  variant = 'default',
  onSuccess,
  onError,
}: {
  children: ReactNode;
  run: () => Promise<unknown>;
  variant?: 'default' | 'outline';
  onSuccess?: () => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          onError('');
          try {
            await run();
            onSuccess?.();
          } catch (error) {
            onError(errorMessage(error, 'Couldn’t update the connection.'));
          }
        })
      }
    >
      {pending && <Spinner data-icon="inline-start" />}
      {children}
    </Button>
  );
}

function IntegrationRow({
  icon,
  title,
  description,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <SettingsList>
      <Item className="flex-wrap">
        <ItemMedia className="flex size-8 items-center justify-center rounded-md border border-gray-alpha-400 text-gray-1000 [&_svg]:size-4">
          {icon}
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="min-w-0">{title}</ItemTitle>
          <ItemDescription className="text-copy-13">{description}</ItemDescription>
        </ItemContent>
        {actions && <ItemActions>{actions}</ItemActions>}
      </Item>
    </SettingsList>
  );
}

export function IntegrationsPanel({
  services,
  workspaceName,
  notice,
}: {
  services: SettingsServices;
  workspaceName: string;
  notice?: IntegrationNotice | undefined;
}) {
  const { client, workspaceId } = services;
  const environment = useSettingsResource(
    useCallback((signal: AbortSignal) => client.settings.environment({ signal }), [client]),
  );
  const pipeline = useSettingsResource(
    useCallback(
      (signal: AbortSignal) => client.pipeline.settings(workspaceId, { signal }),
      [client, workspaceId],
    ),
  );
  const modes = environment.value && 'data' in environment.value ? environment.value.data : null;
  return (
    <>
      <SettingsHeading>Integrations</SettingsHeading>
      <SettingsSection
        title={`After a meeting · ${workspaceName}`}
        data-testid="after-meetings-card"
      >
        {pipeline.value && 'data' in pipeline.value ? (
          <SettingsProvider value={{ ...services, refresh: pipeline.refresh }}>
            <PipelineSwitch
              workspaceId={workspaceId}
              setting="autoEnhance"
              initial={pipeline.value.data.autoEnhance}
              label={AUTO_ENHANCE}
              description={{
                on: 'Oat drafts a clean note when a meeting ends.',
                off: 'Enhance notes yourself with “Enhance” on the note.',
              }}
            />
          </SettingsProvider>
        ) : pipeline.value ? (
          <SettingsLoadState error={pipeline.value.error} retry={pipeline.refresh} />
        ) : (
          <PipelineSwitchSkeleton label={AUTO_ENHANCE} />
        )}
      </SettingsSection>
      <CalendarPanel services={services} notice={notice} mock={modes?.calendar === 'mock'} />
      <NotionPanel
        services={services}
        notice={notice}
        workspaceName={workspaceName}
        configured={modes?.notion !== 'off'}
        mock={modes?.notion === 'mock'}
        autoSend={
          pipeline.value && 'data' in pipeline.value ? pipeline.value.data.autoSendToNotion : null
        }
      />
    </>
  );
}

type IntegrationProps = {
  services: SettingsServices;
  notice?: IntegrationNotice | undefined;
  mock: boolean;
};

function useReturnRefresh(refresh: () => Promise<void>) {
  useEffect(() => {
    const onFocus = () => {
      void refresh().catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
}

function CalendarPanel({ services, notice, mock }: IntegrationProps) {
  const { client, workspaceId, connect } = services;
  const { value, refresh } = useSettingsResource(
    useCallback((signal: AbortSignal) => client.calendar.google.status({ signal }), [client]),
  );
  useReturnRefresh(refresh);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [showNotice, setShowNotice] = useState(true);
  const connection = value && 'data' in value ? value.data : null;
  const connected = connection?.connected === true;
  const needsReconnect = connected && !connection.hasCalendarScope;
  const connectButton = (
    <IntegrationButton
      run={() => connect('google-calendar', workspaceId)}
      onSuccess={() => setConsent(true)}
      onError={setError}
    >
      {connected ? 'Connect again' : 'Connect Google Calendar'}
    </IntegrationButton>
  );
  const callbackError = showNotice ? notice?.calendarError : null;
  return (
    <SettingsSection
      title="Google Calendar"
      description="Read-only calendar access for upcoming meetings."
      action={
        connection && (
          <Badge variant={connected ? 'secondary' : 'outline'} data-testid="google-calendar-status">
            {connected ? 'Connected' : 'Not connected'}
          </Badge>
        )
      }
    >
      {(error || callbackError) && <Message error>{error || callbackError}</Message>}
      {connected && showNotice && notice?.connected === 'google-calendar' && !callbackError && (
        <Message>Google Calendar is connected. Your next meetings now show on Home.</Message>
      )}
      {consent && (!connected || needsReconnect) && <ConsentHint refresh={refresh} />}
      {connection ? (
        <IntegrationRow
          icon={<IconCalendar />}
          title={
            connected ? (
              <span className="truncate" data-testid="google-calendar-account">
                {connection.email ?? 'Google account'}
              </span>
            ) : (
              'Google account'
            )
          }
          description={
            needsReconnect
              ? 'Calendar access wasn’t granted. Connect again and allow it.'
              : connected && connection.connectedAt
                ? `Connected ${formatDate(connection.connectedAt)}`
                : 'Choose a Google account and allow read-only calendar access.'
          }
          actions={
            connected ? (
              <>
                {needsReconnect && connectButton}
                <IntegrationButton
                  variant="outline"
                  run={async () => {
                    await client.calendar.google.disconnect();
                    setShowNotice(false);
                    setConsent(false);
                    await refresh();
                  }}
                  onError={setError}
                >
                  Disconnect
                </IntegrationButton>
              </>
            ) : (
              connectButton
            )
          }
        />
      ) : (
        <SettingsLoadState
          error={value && 'error' in value ? value.error : undefined}
          retry={refresh}
        />
      )}
      {mock && (
        <p className="text-copy-13 text-gray-900">
          Development: Google sign-in and the Calendar API are local mocks.
        </p>
      )}
    </SettingsSection>
  );
}

function NotionPanel({
  services,
  workspaceName,
  notice,
  configured,
  mock,
  autoSend,
}: IntegrationProps & {
  workspaceName: string;
  configured: boolean;
  autoSend: boolean | null;
}) {
  const { client, workspaceId, connect } = services;
  const { value, refresh } = useSettingsResource(
    useCallback(
      (signal: AbortSignal) => client.notion.status(workspaceId, { signal }),
      [client, workspaceId],
    ),
  );
  useReturnRefresh(refresh);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [showNotice, setShowNotice] = useState(true);
  const connection = value && 'data' in value ? value.data : null;
  const reconnect = connection?.needsReconnect === true;
  const callbackError = showNotice ? notice?.notionError : null;
  const connectButton = (
    <IntegrationButton
      run={() => connect('notion', workspaceId)}
      onSuccess={() => setConsent(true)}
      onError={setError}
    >
      {reconnect ? 'Reconnect' : 'Connect Notion'}
    </IntegrationButton>
  );
  return (
    <SettingsSection
      title="Notion"
      description="Send notes to a Notion page or database and keep them up to date. Oat only sees the pages you share with it."
      data-testid="notion-card"
      action={
        value &&
        'data' in value && (
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
        )
      }
    >
      {(error || callbackError) && <Message error>{error || callbackError}</Message>}
      {connection && showNotice && notice?.connected === 'notion' && !callbackError && (
        <Message>Notion is connected. Choose where your notes should go.</Message>
      )}
      {reconnect && (
        <Message error>
          Oat can no longer reach this Notion workspace (access was removed). Connect again to keep
          sending notes.
        </Message>
      )}
      {consent && (!connection || reconnect) && <ConsentHint refresh={refresh} />}
      {value && 'data' in value ? (
        <IntegrationRow
          icon={<IconBrandNotion />}
          title={
            connection ? (
              <span className="truncate" data-testid="notion-workspace">
                {connection.notionWorkspaceName ?? 'Notion workspace'}
              </span>
            ) : configured ? (
              'Not connected'
            ) : (
              'Not available'
            )
          }
          description={
            connection
              ? `For ${workspaceName} · connected ${formatDate(connection.connectedAt)}`
              : configured
                ? `For ${workspaceName}. Notion asks which pages to share with Oat.`
                : 'Notion isn’t set up on this server yet.'
          }
          actions={
            configured &&
            (connection ? (
              <>
                {reconnect && connectButton}
                <IntegrationButton
                  variant="outline"
                  run={async () => {
                    await client.notion.disconnect(workspaceId);
                    setShowNotice(false);
                    setConsent(false);
                    await refresh();
                  }}
                  onError={setError}
                >
                  Disconnect
                </IntegrationButton>
              </>
            ) : (
              connectButton
            ))
          }
        />
      ) : (
        <SettingsLoadState error={value?.error} retry={refresh} />
      )}
      {configured && connection && !reconnect && (
        <SettingsProvider value={{ ...services, refresh }}>
          <NotionTargetPicker workspaceId={workspaceId} target={connection.target} />
          {autoSend !== null && (
            <PipelineSwitch
              workspaceId={workspaceId}
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
              className="inline-flex min-h-6 w-fit items-center gap-1 rounded-md text-label-13 text-gray-900 underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-gray-600/50"
            >
              Open “{connection.target.title || 'Untitled'}” in Notion{' '}
              <IconArrowUpRight aria-hidden className="size-3.5" />
            </a>
          )}
        </SettingsProvider>
      )}
      {mock && (
        <p className="text-copy-13 text-gray-900">
          Development: Notion is a local mock; consent is approved automatically.
        </p>
      )}
    </SettingsSection>
  );
}

function ConsentHint({ refresh }: { refresh: () => Promise<void> }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-copy-13 text-gray-900">
      Finish connecting in your browser, then return here.
      <Button variant="ghost" size="sm" onClick={() => void refresh().catch(() => {})}>
        Check connection
      </Button>
    </p>
  );
}
