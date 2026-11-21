import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconLock } from '@tabler/icons-react';
import type { Metadata } from 'next';

import { BackLink, PageContainer } from '@/components/page';
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
      <div className="flex items-center gap-2 text-label-13 text-gray-900">
        <BackLink href="/templates">Templates</BackLink>
        <span aria-hidden>·</span>
        <span>New in {workspace.name}</span>
      </div>
      {canCreate ? (
        <TemplateEditor mode="create" workspaceId={workspace.id} initial={BLANK} />
      ) : (
        <Empty className="border border-dashed border-gray-alpha-400">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconLock />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              You can’t create templates here
            </EmptyTitle>
            <EmptyDescription>
              Viewers of {workspace.name} can use templates but not create them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PageContainer>
  );
}
