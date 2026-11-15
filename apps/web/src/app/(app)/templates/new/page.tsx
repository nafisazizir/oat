import { LockIcon } from 'lucide-react';
import type { Metadata } from 'next';

import { BackLink, EmptyState, PageContainer } from '@/components/page';
import { TemplateEditor } from '@/components/templates/template-editor';
import { loadNewTemplate } from '@/server/templates/pages';

export const metadata: Metadata = { title: 'New template' };

/** Starting point for a template from scratch: one section to fill in. */
const BLANK = {
  name: '',
  instructions: '',
  sections: [{ heading: 'Summary', instructions: '' }],
};

export default async function NewTemplatePage() {
  const { canCreate, workspace } = await loadNewTemplate();

  return (
    <PageContainer className="gap-6">
      {/* The name field is the visible title; the page still needs a heading. */}
      <h1 className="sr-only">New template</h1>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BackLink href="/templates">Templates</BackLink>
        <span aria-hidden>·</span>
        <span>{workspace.kind === 'personal' ? 'New template' : `New in ${workspace.name}`}</span>
      </div>
      {canCreate ? (
        <TemplateEditor mode="create" workspaceId={workspace.id} initial={BLANK} />
      ) : (
        <EmptyState
          icon={LockIcon}
          title="You can’t create templates here"
          description={`Viewers of ${workspace.name} can use templates but not create them.`}
        />
      )}
    </PageContainer>
  );
}
