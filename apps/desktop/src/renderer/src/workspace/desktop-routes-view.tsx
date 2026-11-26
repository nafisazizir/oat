import { OatApiError } from '@oat/client';
import { BlockFocus } from '@oat/editor/react';
import {
  EmptyState,
  JoinWorkspace,
  InviteResponse,
  PageContainer,
  ShellFolderView,
  TemplatesGallery,
  TemplateView,
  NewTemplateView,
  useShellData,
  useWorkspaceHost,
  type AppRoute,
} from '@oat/workspace-ui';
import { Button } from '@oat/ui/components/button';
import { Skeleton } from '@oat/ui/components/skeleton';
import { IconCloudOff, IconFile } from '@tabler/icons-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { call } from '../bridge';
import { FeatureViews } from '../windows/feature-views';
import { AssistantPageEditor } from './page-assistant';

type DocumentDetail = Awaited<ReturnType<typeof api.documents.get>>;
type FolderSummary = Awaited<ReturnType<typeof api.folders.tree>>[number];

export function OfflineWorkspaceView() {
  const host = useWorkspaceHost();
  return (
    <PageContainer>
      <EmptyState
        icon={IconCloudOff}
        title="You’re offline"
        titleAs="h1"
        description="Pages, folders and templates come back when you reconnect."
      >
        <Button variant="outline" onClick={host.refresh}>
          Try again
        </Button>
      </EmptyState>
    </PageContainer>
  );
}

export function DesktopRoutesView({
  route,
  notes,
  meeting,
  recordingControls,
}: {
  route: AppRoute;
  notes: readonly MeetingNoteSummary[] | null;
  meeting: ReactNode;
  recordingControls?: ReactNode;
}) {
  const shell = useShellData();
  if (route.view === 'home') return meeting;
  if (route.view === 'document') {
    if (
      route.query?.kind === 'meeting' ||
      notes?.some((n) => n.documentId === route.id) ||
      [...shell.documents, ...shell.trash].some((n) => n.id === route.id && n.kind === 'meeting')
    )
      return meeting;
  }
  if (route.view === 'document') {
    const node = shell.documents.find((n) => n.id === route.id);
    return (
      <DocumentRoute
        key={`${route.id}:${shell.workspace.id}`}
        id={route.id}
        blockId={route.query?.block}
        folder={node?.kind === 'folder'}
        meeting={meeting}
        recordingControls={recordingControls}
      />
    );
  }
  return (
    <>
      {recordingControls}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-selectable>
        <ServerRoutes route={route} />
      </div>
    </>
  );
}

function ServerRoutes({ route }: { route: AppRoute }) {
  const host = useWorkspaceHost();
  if (['templates', 'template', 'template-new'].includes(route.view) && !host.online)
    return <OfflineWorkspaceView />;
  switch (route.view) {
    case 'templates':
      return <TemplatesGallery />;
    case 'template':
      return <TemplateView templateId={route.id} />;
    case 'template-new':
      return <NewTemplateView />;
    case 'tasks':
    case 'assistant':
    case 'search':
      return <FeatureViews route={route} />;
    case 'join':
      return <JoinRoute />;
    case 'invite':
      return <JoinRoute token={route.token} />;
    default:
      return null;
  }
}

function JoinRoute({ token }: { token?: string }) {
  const host = useWorkspaceHost();
  const { user } = useShellData();
  const { client, refresh, navigate } = host;
  const onHome = useCallback(
    async (joined?: boolean) => {
      if (joined) {
        const { activeWorkspaceId } = await client.workspaces.list();
        await call('sync:now');
        if (activeWorkspaceId)
          await call('workspaces:set-active', { workspaceId: activeWorkspaceId });
      }
      refresh();
      if (token) await call('navigation:clear');
      navigate({ view: 'home' });
    },
    [client, refresh, navigate, token],
  );
  return (
    <div className="m-auto w-full max-w-[25.5rem] px-6 py-10">
      {token ? (
        <InviteResponse
          key={token}
          client={client}
          token={token}
          onHome={onHome}
          onSwitchAccount={() => call('auth:sign-out')}
        />
      ) : (
        <JoinWorkspace client={client} email={user.email} onHome={onHome} />
      )}
    </div>
  );
}

function DocumentRoute({
  id,
  blockId,
  folder,
  meeting,
  recordingControls,
}: {
  id: string;
  blockId?: string;
  folder: boolean;
  meeting: ReactNode;
  recordingControls?: ReactNode;
}) {
  const shell = useShellData();
  const host = useWorkspaceHost();
  const [data, setData] = useState<DocumentDetail | FolderSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inTrash = shell.trash.some((node) => node.id === id);
  useEffect(() => {
    if (!host.online) return;
    let active = true;
    const load = folder
      ? api.folders
          .tree(shell.workspace.id)
          .then((folders) => folders.find((f) => f.id === id) ?? null)
      : api.documents.get(id);
    void load.then(
      (doc) => {
        if (active) {
          setData(doc);
          setError(doc ? null : 'This item is unavailable.');
        }
      },
      (error: unknown) => {
        if (active && !(error instanceof OatApiError && error.status === 0))
          setError(error instanceof OatApiError ? error.message : 'Couldn’t load this page.');
      },
    );
    return () => {
      active = false;
    };
  }, [id, folder, shell.workspace.id, inTrash, host.online]);
  const wrap = (content: ReactNode) => (
    <>
      {recordingControls}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-selectable>
        {content}
      </div>
    </>
  );
  if (!host.online && (!data || folder)) return wrap(<OfflineWorkspaceView />);
  if (error)
    return wrap(
      <PageContainer>
        <EmptyState icon={IconFile} title="Page unavailable" titleAs="h1" description={error} />
      </PageContainer>,
    );
  if (!data)
    return wrap(
      <PageContainer className="gap-6" aria-busy>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-64 w-full" />
      </PageContainer>,
    );
  if ('kind' in data)
    return data.kind === 'meeting'
      ? meeting
      : wrap(
          <>
            {!host.online && (
              <div
                role="status"
                className="flex items-center gap-2 px-6 py-2 text-copy-13 text-amber-900"
              >
                <IconCloudOff className="size-4" aria-hidden />
                You’re offline. Keep this page open; unsaved edits will retry when you reconnect.
              </div>
            )}
            <AssistantPageEditor
              document={data}
              workspace={shell.workspaces.find((w) => w.id === data.workspaceId) ?? shell.workspace}
            />
            <BlockFocus blockId={blockId} />
          </>,
        );
  const live = shell.documents.find((node) => node.id === data.id && node.kind === 'folder');
  return wrap(
    <ShellFolderView
      folder={
        live
          ? {
              ...data,
              name: live.title,
              visibility: live.visibility === 'private' ? 'private' : 'workspace',
              access: live.access,
              updatedAt: live.updatedAt,
              parentId: live.parentId,
            }
          : data
      }
    />,
  );
}
