import type { DesktopUser, MeetingNoteSummary } from '@oat/core/bridge';
import { FeatureUiProvider, useFeatureUi, type AppTarget } from '@oat/feature-ui';
import { AssistantChat } from '@oat/feature-ui/assistant';
import { SearchView, serverSearchSource } from '@oat/feature-ui/search';
import { TasksView, type TaskFilters } from '@oat/feature-ui/tasks';
import { SidebarMenuItem, SidebarMenuButton } from '@oat/ui/components/sidebar';
import { IconSparkles, IconChecklist } from '@tabler/icons-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { bridge } from '../bridge.ts';
import { api, apiTransport } from '../lib/api.ts';
import { localSearchSource } from '../sync/local-search-source.ts';

export type FeatureView =
  { kind: 'assistant'; threadId?: string } | { kind: 'tasks' } | { kind: 'search'; q: string };

export function FeatureNavigation({
  view,
  onView,
}: {
  view: FeatureView | null;
  onView(view: FeatureView): void;
}) {
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view?.kind === 'assistant'}
          onClick={() => onView({ kind: 'assistant' })}
        >
          <IconSparkles />
          Assistant
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view?.kind === 'tasks'}
          onClick={() => onView({ kind: 'tasks' })}
        >
          <IconChecklist />
          My tasks
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  );
}

export function DesktopFeatureProvider({
  user,
  workspaceId,
  notes,
  refreshKey,
  onOpenMeeting,
  onView,
  children,
}: {
  user: DesktopUser;
  workspaceId: string;
  notes: MeetingNoteSummary[] | null;
  refreshKey: number | null;
  onOpenMeeting(id: string): void;
  onView(view: FeatureView): void;
  children: ReactNode;
}) {
  const navigate = useCallback(
    (target: AppTarget) => {
      if (target.kind !== 'document') {
        onView(target);
        return;
      }
      if (notes?.some((note) => note.documentId === target.id)) {
        onOpenMeeting(target.id);
        return;
      }
      const params = new URLSearchParams();
      if (target.blockId) params.set('block', target.blockId);
      if (target.segmentId) params.set('seg', target.segmentId);
      if (target.timeMs !== undefined) params.set('t', String(Math.floor(target.timeMs / 1000)));
      // Pages are web-only until the native page viewer lands; main resolves the configured web origin.
      bridge().send('shell:open-external', {
        url: `/d/${encodeURIComponent(target.id)}${params.size ? `?${params}` : ''}`,
      });
    },
    [notes, onOpenMeeting, onView],
  );
  const sources = useMemo(
    () => [
      { ...localSearchSource(), id: `local:${refreshKey ?? 'initial'}` },
      serverSearchSource(api),
    ],
    [refreshKey],
  );
  const value = useMemo(
    () => ({
      client: api,
      transport: apiTransport,
      workspaceId,
      user: { ...user, name: user.name || user.email },
      navigate,
      notify: toast,
      searchSources: sources,
    }),
    [workspaceId, user, navigate, sources],
  );
  return <FeatureUiProvider value={value}>{children}</FeatureUiProvider>;
}

export function FeatureViews({ view, workspaceId }: { view: FeatureView; workspaceId: string }) {
  if (!workspaceId)
    return (
      <p role="status" className="p-6 text-copy-14 text-gray-900">
        Choose a workspace to continue.
      </p>
    );
  return <FeatureContent key={workspaceId} view={view} workspaceId={workspaceId} />;
}

function FeatureContent({ view, workspaceId }: { view: FeatureView; workspaceId: string }) {
  const { navigate } = useFeatureUi();
  const [filters, setFilters] = useState<TaskFilters>({
    view: 'assigned',
    status: 'open',
    due: 'any',
  });
  const [type, setType] = useState<'notes' | 'transcripts'>('notes');
  if (view.kind === 'assistant')
    return (
      <AssistantChat
        scope={{ kind: 'workspace', workspaceId }}
        workspaceId={workspaceId}
        layout="page"
        selectedThreadId={view.threadId}
      />
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
      <div className="mx-auto w-full max-w-content">
        <h1 className="mb-6 text-heading-24">{view.kind === 'tasks' ? 'My tasks' : 'Search'}</h1>
        {view.kind === 'tasks' ? (
          <TasksView value={filters} onChange={setFilters} />
        ) : (
          <SearchView
            query={view.q}
            onQueryChange={(q) => navigate({ kind: 'search', q })}
            type={type}
            onTypeChange={setType}
          />
        )}
      </div>
    </section>
  );
}
