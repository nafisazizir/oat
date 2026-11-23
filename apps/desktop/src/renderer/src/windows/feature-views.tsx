import type { MeetingNoteSummary } from '@oat/core/bridge';
import { FeatureUiProvider, FeaturePageHeader, useFeatureUi } from '@oat/feature-ui';
import { createWorkspaceFeatureAdapter } from '@oat/feature-ui/workspace';
import { AssistantChat } from '@oat/feature-ui/assistant';
import { SearchView, serverSearchSource } from '@oat/feature-ui/search';
import { TasksView, type TaskFilters } from '@oat/feature-ui/tasks';
import { useShellData, useWorkspaceHost, type AppRoute } from '@oat/workspace-ui';
import { useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { apiTransport } from '../lib/api.ts';
import { localSearchSource } from '../sync/local-search-source.ts';

export function DesktopFeatureProvider({
  notes,
  refreshKey,
  children,
}: {
  notes: readonly MeetingNoteSummary[] | null;
  refreshKey: number | null;
  children: ReactNode;
}) {
  const host = useWorkspaceHost();
  const { workspace, user } = useShellData();
  const sources = useMemo(
    () => [
      { ...localSearchSource(), id: `local:${refreshKey ?? 'initial'}` },
      serverSearchSource(host.client),
    ],
    [refreshKey, host.client],
  );
  const value = useMemo(
    () =>
      createWorkspaceFeatureAdapter(host, {
        transport: apiTransport,
        notify: toast,
        workspaceId: workspace.id,
        user,
        searchSources: sources,
        openDocument(route) {
          if (notes?.some((note) => note.documentId === route.id)) {
            host.navigate({ ...route, query: { ...route.query, kind: 'meeting' } });
          } else {
            host.navigate(route);
          }
        },
      }),
    [host, workspace.id, user, sources, notes],
  );
  return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
}

type FeatureRoute = Extract<AppRoute, { view: 'assistant' | 'tasks' | 'search' }>;

export function FeatureViews({ route }: { route: FeatureRoute }) {
  const { workspace } = useShellData();
  if (!workspace.id)
    return (
      <p role="status" className="p-6 text-copy-14 text-gray-900">
        Choose a workspace to continue.
      </p>
    );
  return (
    <FeatureContent
      key={workspace.id}
      route={route}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
    />
  );
}

function FeatureContent({
  route,
  workspaceId,
  workspaceName,
}: {
  route: FeatureRoute;
  workspaceId: string;
  workspaceName: string;
}) {
  const { navigate } = useFeatureUi();
  const host = useWorkspaceHost();
  const filters: TaskFilters =
    route.view === 'tasks' && route.filters
      ? route.filters
      : {
          view: 'assigned',
          status: 'open',
          due: 'any',
        };
  if (route.view === 'assistant')
    return (
      <AssistantChat
        scope={{ kind: 'workspace', workspaceId }}
        workspaceId={workspaceId}
        layout="page"
        selectedThreadId={route.threadId ?? null}
        onThreadChange={(id) => navigate({ kind: 'assistant', ...(id ? { threadId: id } : {}) })}
      />
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-content flex-col gap-8 px-6 py-10 sm:px-8 sm:py-14">
        <FeaturePageHeader kind={route.view} workspaceName={workspaceName} />
        {route.view === 'tasks' ? (
          <TasksView
            value={filters}
            onChange={(filters) => host.navigate({ view: 'tasks', filters })}
          />
        ) : (
          <SearchView
            query={route.q ?? ''}
            onQueryChange={(q) => host.navigate({ ...route, q })}
            type={route.type ?? 'notes'}
            onTypeChange={(type) => host.navigate({ ...route, type })}
          />
        )}
      </div>
    </section>
  );
}
