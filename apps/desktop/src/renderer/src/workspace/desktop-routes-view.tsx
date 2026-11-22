import { OatApiError } from '@oat/client';
import {
  EmptyState,
  PageContainer,
  PageEditor,
  ShareDialog,
  ShellFolderView,
  TemplatesGallery,
  TemplateView,
  NewTemplateView,
  useShellData,
  useTreeActions,
  useWorkspaceHost,
  type AppRoute,
} from '@oat/workspace-ui';
import { Button } from '@oat/ui/components/button';
import { Skeleton } from '@oat/ui/components/skeleton';
import { IconCloudOff, IconFile } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { PlaceholderView } from '../views/placeholder-view';

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
      shell.documents.some((n) => n.id === route.id && n.kind === 'meeting')
    )
      return (
        <>
          <MeetingActions id={route.id} />
          {meeting}
        </>
      );
  }
  return (
    <>
      {recordingControls}
      <div className="min-h-0 flex-1 overflow-auto" data-selectable>
        <ServerRoutes route={route} meeting={meeting} />
      </div>
    </>
  );
}

function ServerRoutes({ route, meeting }: { route: AppRoute; meeting: ReactNode }) {
  const host = useWorkspaceHost();
  const shell = useShellData();
  if (route.view === 'document') {
    const node = shell.documents.find((n) => n.id === route.id);
    return (
      <DocumentRoute
        key={`${route.id}:${shell.workspace.id}`}
        id={route.id}
        folder={node?.kind === 'folder'}
        meeting={meeting}
      />
    );
  }
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
      return <PlaceholderView title="My tasks" />;
    case 'assistant':
      return <PlaceholderView title="Assistant" />;
    case 'search':
      return <PlaceholderView title="Search" />;
    case 'join':
      return <PlaceholderView title="Join a workspace" />;
    default:
      return null;
  }
}

function MeetingActions({ id }: { id: string }) {
  const shell = useShellData();
  const host = useWorkspaceHost();
  const actions = useTreeActions();
  const node = shell.documents.find((n) => n.id === id);
  return (
    <div className="flex shrink-0 justify-end gap-2 px-4 py-2">
      <ShareDialog documentId={id} />
      {node?.access.delete && (
        <Button
          size="sm"
          variant="ghost"
          disabled={!host.online}
          onClick={() => actions.remove(node)}
        >
          Move to trash
        </Button>
      )}
    </div>
  );
}

function DocumentRoute({
  id,
  folder,
  meeting,
}: {
  id: string;
  folder: boolean;
  meeting: ReactNode;
}) {
  const shell = useShellData();
  const host = useWorkspaceHost();
  const [data, setData] = useState<DocumentDetail | FolderSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [id, folder, shell.workspace.id, host.online]);
  if (!host.online && (!data || folder)) return <OfflineWorkspaceView />;
  if (error)
    return (
      <PageContainer>
        <EmptyState icon={IconFile} title="Page unavailable" titleAs="h1" description={error} />
      </PageContainer>
    );
  if (!data)
    return (
      <PageContainer className="gap-6" aria-busy>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  if ('kind' in data)
    return data.kind === 'meeting' ? (
      meeting
    ) : (
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
        <PageEditor
          document={data}
          workspace={shell.workspaces.find((w) => w.id === data.workspaceId) ?? shell.workspace}
        />
      </>
    );
  const live = shell.documents.find((node) => node.id === data.id && node.kind === 'folder');
  return (
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
    />
  );
}
