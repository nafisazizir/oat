import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FeaturePageHeader } from '@oat/feature-ui';

import { PageContainer } from '@/components/page';
import { TasksViewSkeleton } from '@oat/feature-ui/tasks';
import { TasksView } from '@/components/tasks/tasks-view';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'My tasks' };

/** `/tasks?view=&status=&due=`: action items across the active workspace's notes (8.4). */
export default async function TasksPage() {
  const { workspace } = await getShellData();
  return (
    <PageContainer className="gap-8">
      <FeaturePageHeader kind="tasks" workspaceName={workspace.name} />
      {/* `useSearchParams` needs a boundary; the view takes its filters from the URL on the client. */}
      <Suspense fallback={<TasksViewSkeleton />}>
        <TasksView key={workspace.id} />
      </Suspense>
    </PageContainer>
  );
}
