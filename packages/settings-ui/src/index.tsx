'use client';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@oat/ui/components/input-group';
import {
  SettingsLayout,
  SettingsNavGroup,
  settingsNavClass,
} from '@oat/ui/components/settings-layout';
import {
  IconAdjustments,
  IconBuilding,
  IconDatabase,
  IconMicrophone,
  IconPlug,
  IconSearch,
  IconShield,
  IconUser,
  IconUsers,
} from '@tabler/icons-react';
import { useCallback, useState, type ReactNode } from 'react';

import { WorkspaceDangerZone } from './danger-zone';
import { WorkspaceGeneralForm } from './general-form';
import { IntegrationsPanel, type IntegrationNotice } from './integrations-panel';
import { WorkspaceJoinSettings } from './join-settings';
import { MembersPanel } from './members-panel';
import { AppearancePanel } from './preferences';
import { ProfileForm } from './profile-form';
import {
  settingsCacheKeys,
  SettingsLoadState,
  SettingsResourceCache,
  useSettingsPrefetch,
  useSettingsResource,
} from './resource';
import { SettingsHeading, SettingsSection } from './section';
import { SettingsProvider, type SettingsServices } from './services';
import type { ThemePreference } from './theme';

export { LeaveWorkspaceDialog } from './leave-workspace-dialog';
export { SettingsHeading, SettingsList, SettingsSection } from './section';
export { type SettingsServices } from './services';
export { ThemeProvider, useTheme } from './theme-provider';
export { ThemeMenu } from './theme-menu';
export { WorkspaceAvatar } from './workspace-avatar';

export const settingsPaths = {
  profile: '/settings/profile',
  preferences: '/settings',
  integrations: '/settings/integrations',
  workspace: '/settings/workspace',
  members: '/settings/workspace/members',
} as const;
export type SharedSettingsSection = keyof typeof settingsPaths;
type DeviceSection = 'recording' | 'storage' | 'setup';
export type SettingsSectionId = SharedSettingsSection | DeviceSection;

const entries = {
  profile: ['Profile', IconUser, 'account name role team vocabulary'],
  preferences: ['Preferences', IconAdjustments, 'appearance theme dark light system'],
  integrations: ['Integrations', IconPlug, 'notion google calendar pipeline auto enhance meetings'],
  workspace: ['General', IconBuilding, 'workspace name icon domain policy export leave delete'],
  members: ['Members', IconUsers, 'workspace people roles invites requests'],
  recording: ['Recording', IconMicrophone, 'microphone auto stop audio'],
  storage: ['Storage', IconDatabase, 'disk files retention'],
  setup: ['Setup', IconShield, 'permissions microphone system audio calendar'],
} as const;
const groups = [
  { label: 'Account', ids: ['profile', 'preferences', 'integrations'] },
  { label: 'Workspace', ids: ['workspace', 'members'] },
  { label: 'This device', ids: ['setup', 'recording', 'storage'] },
] as const;

type ShellProps = {
  active: SettingsSectionId;
  workspaceName: string;
  renderLink: (
    id: SettingsSectionId,
    props: {
      children: ReactNode;
      className: string;
      'aria-current'?: 'page';
      'data-testid': string;
    },
  ) => ReactNode;
  devicePanels?: Partial<Record<DeviceSection, ReactNode>>;
  back?: ReactNode;
  /** Where the navigation sticks, for a host whose scroll container isn't the page (desktop). */
  navigationClassName?: string;
  children: ReactNode;
};

export function SettingsShell({
  active,
  workspaceName,
  renderLink,
  devicePanels,
  back,
  navigationClassName,
  children,
}: ShellProps) {
  const [query, setQuery] = useState('');
  const terms = query.trim().toLowerCase().split(/\s+/);
  const available = groups.map(({ label, ids }) => ({
    label,
    ids: ids.filter((id) => {
      if (!(id in settingsPaths) && !devicePanels?.[id as DeviceSection]) return false;
      return terms.every((term) =>
        `${entries[id][0]} ${entries[id][2]}`.toLowerCase().includes(term),
      );
    }),
  }));
  return (
    <SettingsLayout
      navigationClassName={navigationClassName}
      navigation={
        <>
          {back}
          {/* Glyph and text on the columns of the section icons and names below. */}
          <InputGroup
            size="sm"
            variant="secondary"
            className="[--input-group-inset:7px] has-[>[data-align=inline-start]]:[&>input]:ps-2"
          >
            <InputGroupAddon>
              <IconSearch />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          {available.map(({ label, ids }) =>
            ids.length ? (
              <SettingsNavGroup key={label} label={label}>
                {label === 'Workspace' && workspaceName && (
                  <p className="truncate px-2 pb-1 text-label-12 text-gray-900">{workspaceName}</p>
                )}
                {ids.map((id) => {
                  const [title, Icon] = entries[id];
                  return renderLink(id, {
                    className: settingsNavClass(active === id),
                    'aria-current': active === id ? 'page' : undefined,
                    'data-testid':
                      id === 'profile' ? 'settings-profile-link' : `settings-section-${id}`,
                    children: (
                      <>
                        <Icon aria-hidden className="size-4 shrink-0 text-gray-900" />
                        {title}
                      </>
                    ),
                  });
                })}
              </SettingsNavGroup>
            ) : null,
          )}
          {available.every(({ ids }) => !ids.length) && (
            <p className="px-2 text-copy-13 text-gray-900" role="status">
              No settings found.
            </p>
          )}
        </>
      }
    >
      <SettingsResourceCache>
        {active in settingsPaths ? children : null}
        {devicePanels &&
          Object.entries(devicePanels).map(([id, panel]) => (
            <div key={id} hidden={id !== active}>
              {panel}
            </div>
          ))}
      </SettingsResourceCache>
    </SettingsLayout>
  );
}

export function SettingsPanel({
  active,
  services,
  workspaceName,
  theme,
  setTheme,
  notice,
}: {
  active: SettingsSectionId;
  services: SettingsServices;
  workspaceName: string;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  notice?: IntegrationNotice;
}) {
  const key = `${services.workspaceId}:${active}`;
  const { client, workspaceId } = services;
  // The cheap reads behind the other pages, so switching to one doesn't start from "Loading".
  useSettingsPrefetch({
    [settingsCacheKeys.profile]: (signal) => client.profile.get({ signal }),
    [settingsCacheKeys.environment]: (signal) => client.settings.environment({ signal }),
    ...(workspaceId && {
      [settingsCacheKeys.workspace(workspaceId)]: (signal) =>
        client.workspaces.get(workspaceId, { signal }),
      [settingsCacheKeys.pipeline(workspaceId)]: (signal) =>
        client.pipeline.settings(workspaceId, { signal }),
    }),
  });
  switch (active) {
    case 'preferences':
      return <AppearancePanel client={services.client} theme={theme} setTheme={setTheme} />;
    case 'profile':
      return <ProfilePanel key={key} services={services} />;
    case 'integrations':
      return (
        <IntegrationsPanel
          key={key}
          services={services}
          workspaceName={workspaceName}
          notice={notice}
        />
      );
    case 'workspace':
    case 'members':
      return <WorkspacePanel key={key} active={active} services={services} />;
    default:
      return null;
  }
}

function ProfilePanel({ services }: { services: SettingsServices }) {
  const { client } = services;
  const load = useCallback((signal: AbortSignal) => client.profile.get({ signal }), [client]);
  const { value, refresh } = useSettingsResource(load, settingsCacheKeys.profile);
  return (
    <>
      <SettingsHeading>Profile</SettingsHeading>
      {value && 'data' in value ? (
        <SettingsProvider value={{ ...services, refresh }}>
          {/* Keyed by its save time: a newer profile than the one shown starts the form over. */}
          <ProfileForm key={String(value.data.updatedAt)} profile={value.data} />
        </SettingsProvider>
      ) : (
        <SettingsLoadState error={value?.error} retry={refresh} />
      )}
    </>
  );
}

function WorkspacePanel({
  active,
  services,
}: {
  active: 'workspace' | 'members';
  services: SettingsServices;
}) {
  const { client, workspaceId } = services;
  const load = useCallback(
    (signal: AbortSignal) => client.workspaces.get(workspaceId, { signal }),
    [client, workspaceId],
  );
  const { value, refresh } = useSettingsResource(load, settingsCacheKeys.workspace(workspaceId));
  if (!value || 'error' in value)
    return (
      <>
        <SettingsHeading>{entries[active][0]}</SettingsHeading>
        <SettingsLoadState error={value?.error} retry={refresh} />
      </>
    );
  const settings = value.data;
  const { workspace } = settings;
  return (
    <SettingsProvider value={{ ...services, refresh }}>
      {active === 'members' ? (
        <MembersPanel settings={settings} />
      ) : (
        <>
          <SettingsHeading>General</SettingsHeading>
          {/* Keyed by what it edits: a name or icon changed elsewhere starts the form over. */}
          <WorkspaceGeneralForm
            key={`${workspace.name}:${workspace.icon}`}
            workspace={workspace}
            canEdit={settings.canManage}
          />
          {settings.joining && (
            <WorkspaceJoinSettings workspaceId={workspace.id} joining={settings.joining} />
          )}
          <SettingsSection title="Danger zone" aria-label="Danger zone" data-testid="danger-zone">
            <WorkspaceDangerZone
              workspace={workspace}
              canLeave={settings.canLeave}
              canDelete={settings.canDelete}
              isOwner={settings.role === 'owner'}
              lastWorkspace={settings.lastWorkspace}
              restoreDays={settings.restoreDays}
            />
          </SettingsSection>
        </>
      )}
    </SettingsProvider>
  );
}
