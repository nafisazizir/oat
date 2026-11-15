import { ChevronLeftIcon, LockIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState, PageContainer } from '@/components/page';
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link
          href="/templates"
          className="-ml-1 inline-flex items-center gap-0.5 rounded-md pr-1 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronLeftIcon className="size-3.5" />
          Templates
        </Link>
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
