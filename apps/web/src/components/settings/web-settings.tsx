'use client';

import { createOatClient, fetchTransport, OatApiError } from '@oat/client';
import {
  SettingsPanel,
  SettingsShell,
  settingsPaths,
  useTheme,
  type SettingsServices,
  type SharedSettingsSection,
} from '@oat/settings-ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';

import { authClient, GOOGLE_CALENDAR_PROVIDER_ID } from '@/lib/auth-client';

const client = createOatClient(fetchTransport());
const Workspace = createContext<{ id: string; name: string } | null>(null);

export async function downloadWorkspaceNotes(id: string) {
  let response: Response;
  try {
    response = await client.workspaces.export(id);
  } catch (error) {
    if (error instanceof OatApiError && error.status === 429) throw error;
    throw new Error('Couldn’t export your notes. Nothing was downloaded — try again.', {
      cause: error,
    });
  }
  const blob = await response.blob();
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
    'oat-notes.zip';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  return Number(response.headers.get('x-oat-export-count'));
}

async function connect(provider: Parameters<SettingsServices['connect']>[0], workspaceId: string) {
  if (provider === 'notion') {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = client.notion.connectUrl();
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'workspaceId';
    input.value = workspaceId;
    form.append(input);
    document.body.append(form);
    form.submit();
    return;
  }
  const { error } = await authClient.linkSocial({
    provider: GOOGLE_CALENDAR_PROVIDER_ID,
    callbackURL: '/settings/integrations?connected=google-calendar',
    errorCallbackURL: '/settings/integrations',
  });
  if (error) throw new Error(error.message ?? 'Couldn’t start connecting Google Calendar.');
}

export function WebSettingsShell({
  workspace,
  children,
}: {
  workspace: { id: string; name: string };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active =
    (Object.keys(settingsPaths) as SharedSettingsSection[]).find(
      (id) => settingsPaths[id] === pathname,
    ) ?? 'preferences';
  return (
    <Workspace.Provider value={workspace}>
      <SettingsShell
        active={active}
        workspaceName={workspace.name}
        renderLink={(id, props) =>
          id in settingsPaths ? (
            <Link key={id} href={settingsPaths[id as SharedSettingsSection]} {...props} />
          ) : null
        }
      >
        {children}
      </SettingsShell>
    </Workspace.Provider>
  );
}

export function WebSettingsPanel({
  active,
  notice,
}: Pick<ComponentProps<typeof SettingsPanel>, 'active' | 'notice'>) {
  const workspace = useContext(Workspace);
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  if (!workspace) throw new Error('Settings workspace is missing.');
  return (
    <SettingsPanel
      active={active}
      workspaceName={workspace.name}
      theme={theme}
      setTheme={setTheme}
      notice={notice}
      services={{
        client,
        connect,
        workspaceId: workspace.id,
        exportNotes: downloadWorkspaceNotes,
        onProfileChanged: () => router.refresh(),
        onWorkspaceChanged: () => router.refresh(),
        onWorkspaceExited: () => {
          router.replace('/home');
          router.refresh();
        },
      }}
    />
  );
}
