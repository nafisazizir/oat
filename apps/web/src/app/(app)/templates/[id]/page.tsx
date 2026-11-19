import { Badge } from '@oat/ui/components/badge';
import { IconEye } from '@tabler/icons-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { BackLink, PageContainer, PageHeader, SectionHeading } from '@/components/page';
import { DuplicateButton } from '@/components/templates/duplicate-button';
import { TemplateEditor } from '@/components/templates/template-editor';
import { TemplatePreview } from '@/components/templates/template-preview';
import { loadTemplate } from '@/server/templates/pages';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: (await loadTemplate(id))?.template.name ?? 'Template not found' };
}

export default async function TemplatePage({ params }: Props) {
  const { id } = await params;
  const detail = await loadTemplate(id);
  if (!detail) notFound();
  const { template, canEdit, canDuplicate, workspace } = detail;

  if (canEdit) {
    return (
      <PageContainer className="gap-6">
        {/* The name field is the visible title; the page still needs a heading. */}
        <h1 className="sr-only">Edit template</h1>
        <div className="flex items-center gap-2 text-label-13 text-gray-900">
          <BackLink href="/templates">Templates</BackLink>
          <span aria-hidden>·</span>
          <span>
            {template.workspaceId !== workspace.id
              ? 'From another workspace'
              : workspace.kind === 'personal'
                ? 'Your template'
                : `In ${workspace.name}`}
          </span>
        </div>
        <TemplateEditor
          // A fresh form per template (navigating /templates/a → /templates/b keeps this page mounted).
          key={template.id}
          mode="edit"
          workspaceId={template.workspaceId!}
          templateId={template.id}
          initial={{
            name: template.name,
            instructions: template.instructions,
            sections: template.sections,
          }}
          canDuplicate={canDuplicate}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title={template.name}
        description={template.instructions}
        eyebrow={
          <>
            <BackLink href="/templates">Templates</BackLink>
            <span aria-hidden>·</span>
            {template.isBuiltin ? (
              <Badge variant="outline">Built-in</Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <IconEye data-icon="inline-start" />
                View only
              </Badge>
            )}
          </>
        }
      >
        {canDuplicate && (
          <DuplicateButton
            workspaceId={workspace.id}
            templateId={template.id}
            label={template.isBuiltin ? 'Duplicate to customize' : 'Duplicate'}
          />
        )}
      </PageHeader>

      <section className="flex flex-col gap-3">
        <SectionHeading>Sections</SectionHeading>
        <ol className="flex flex-col divide-y divide-gray-alpha-400 rounded-xl border border-gray-alpha-400">
          {template.sections.map((section, i) => (
            <li key={`${i}-${section.heading}`} className="flex gap-4 p-4">
              <span className="w-5 shrink-0 pt-0.5 text-end text-label-12 text-gray-900 tabular-nums">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-label-14 text-gray-1000">{section.heading}</span>
                {section.instructions && (
                  <p className="text-copy-14 text-gray-900">{section.instructions}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
        {template.isBuiltin && (
          <p className="text-copy-13 text-gray-900">
            Built-in templates can’t be edited.{' '}
            {canDuplicate
              ? 'Duplicate this one to make your own version.'
              : 'Ask a workspace member to make a custom version.'}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading>Preview</SectionHeading>
        <TemplatePreview
          name={template.name}
          instructions={template.instructions}
          sections={template.sections}
        />
      </section>
    </PageContainer>
  );
}
