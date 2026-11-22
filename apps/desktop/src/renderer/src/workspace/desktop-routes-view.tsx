import { OatApiError } from '@oat/client';
import { BlockFocus } from '@oat/editor/react';
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@oat/ui/components/dropdown-menu';
import { createPortal } from 'react-dom';
import { Skeleton } from '@oat/ui/components/skeleton';
import { IconCloudOff, IconFile, IconDots, IconTrash } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { PlaceholderView } from '../views/placeholder-view';
import { FeatureViews } from '../windows/feature-views';

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
  toolbar,
}: {
  route: AppRoute;
  notes: readonly MeetingNoteSummary[] | null;
  meeting: ReactNode;
  recordingControls?: ReactNode;
  toolbar?: HTMLElement | null;
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
          <MeetingActions id={route.id} toolbar={toolbar} />
          {meeting}
        </>
      );
  }
  return (
    <>
      {recordingControls}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-selectable>
        <ServerRoutes route={route} meeting={meeting} />
      </div>
    </>
  );
}

function ServerRoutes({ route, meeting }: { route: AppRoute; meeting: ReactNode }) {
  const host = useWorkspaceHost();
  const shell = useShellData();
  if (route.view === 'document') {
    if (!host.online) return <OfflineWorkspaceView />;
    const node = shell.documents.find((n) => n.id === route.id);
    return (
      <DocumentRoute
        key={`${route.id}:${shell.workspace.id}`}
        id={route.id}
        blockId={route.query?.block}
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
    case 'assistant':
    case 'search':
      return <FeatureViews route={route} />;
    case 'join':
      return <PlaceholderView title="Join a workspace" />;
    default:
      return null;
  }
}

function MeetingActions({ id, toolbar }: { id: string; toolbar?: HTMLElement | null }) {
  const shell = useShellData();
  const host = useWorkspaceHost();
  const actions = useTreeActions();
  const node = shell.documents.find((n) => n.id === id);
  const content = (
    <div className="flex shrink-0 items-center gap-2">
      <ShareDialog documentId={id} />
      {node?.access.delete && (
        <DropdownMenu size="sm">
          <DropdownMenuTrigger
            render={<Button variant="secondary" size="icon-sm" aria-label="Page actions" />}
          >
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              disabled={!host.online}
              onClick={() => actions.remove(node)}
            >
              <IconTrash />
              Move to trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  return toolbar ? createPortal(content, toolbar) : content;
}

function DocumentRoute({
  id,
  blockId,
  folder,
  meeting,
}: {
  id: string;
  blockId?: string;
  folder: boolean;
  meeting: ReactNode;
}) {
  const shell = useShellData();
  const [data, setData] = useState<DocumentDetail | FolderSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inTrash = shell.trash.some((node) => node.id === id);
  useEffect(() => {
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
          if (!doc) setError('This item is unavailable.');
        }
      },
      (error: unknown) => {
        if (active)
          setError(error instanceof OatApiError ? error.message : 'Couldn’t load this page.');
      },
    );
    return () => {
      active = false;
    };
  }, [id, folder, shell.workspace.id, inTrash]);
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
        <PageEditor
          document={data}
          workspace={shell.workspaces.find((w) => w.id === data.workspaceId) ?? shell.workspace}
        />
        <BlockFocus blockId={blockId} />
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
