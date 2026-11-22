import { EmptyState, PageContainer } from '@oat/workspace-ui';
import { IconLayout } from '@tabler/icons-react';

/** Integration slot for C3: Assistant, My tasks and server search. */
export function PlaceholderView({ title }: { title: string }) {
  return (
    <PageContainer>
      <EmptyState
        icon={IconLayout}
        title={title}
        titleAs="h1"
        description="Coming to the desktop app soon."
      />
    </PageContainer>
  );
}
