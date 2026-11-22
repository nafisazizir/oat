'use client';

import type { TemplateDetail, TemplateList } from '@oat/services/dto/templates';
import { Badge } from '@oat/ui/components/badge';
import { IconChevronLeft, IconEye, IconLock } from '@tabler/icons-react';
import { useCallback } from 'react';
import { useWorkspaceHost } from './host';
import { DuplicateButton } from './duplicate-button';
import { EmptyState, PageContainer, PageHeader, SectionHeading } from './page';
import { useShellData } from './shell-data';
import { TemplateEditor } from './template-editor';
import { TemplatePreview } from './template-preview';
import { TemplateLoading, useTemplateResource } from './template-resource';

type Workspace = { id: string; name: string };
type InitialDetail = TemplateDetail & { workspace?: Workspace };
type InitialNew = Pick<TemplateList, 'canCreate'> & { workspace?: Workspace };

function TemplatesBackLink() {
  const { Link } = useWorkspaceHost();
  return (
    <Link
      route={{ view: 'templates' }}
      className="-ms-1 inline-flex min-h-6 w-fit items-center gap-0.5 rounded-sm pe-1 text-label-13 text-gray-900 transition-colors hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
    >
      <IconChevronLeft className="size-3.5" aria-hidden />
      Templates
    </Link>
  );
}

export function TemplateView({
  templateId,
  initialData,
}: {
  templateId: string;
  initialData?: InitialDetail;
}) {
  const shell = useShellData();
  const workspace = initialData?.workspace ?? shell.workspace;
  return (
    <Detail
      key={`${workspace.id}:${templateId}`}
      templateId={templateId}
      initialData={initialData}
      workspace={workspace}
    />
  );
}

function Detail({
  templateId,
  initialData,
  workspace,
}: {
  templateId: string;
  initialData?: InitialDetail;
  workspace: Workspace;
}) {
  const { client } = useWorkspaceHost();
  const load = useCallback(
    () => client.templates.get(templateId, workspace.id),
    [client, templateId, workspace.id],
  );
  const { data, error, retry } = useTemplateResource<TemplateDetail>(initialData, load);
  if (!data) return <TemplateLoading error={error} retry={retry} />;
  const { template, canEdit, canDuplicate } = data;
  if (canEdit)
    return (
      <PageContainer className="gap-6">
        <h1 className="sr-only">Edit template</h1>
        <div className="flex items-center gap-2 text-label-13 text-gray-900">
          <TemplatesBackLink />
          <span aria-hidden>·</span>
          <span>
            {template.workspaceId !== workspace.id
              ? 'From another workspace'
              : `In ${workspace.name}`}
          </span>
        </div>
        <TemplateEditor
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
  return (
    <PageContainer>
      <PageHeader
        title={template.name}
        description={template.instructions}
        eyebrow={
          <>
            <TemplatesBackLink />
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
        <ol className="flex flex-col divide-y divide-gray-alpha-400 rounded-lg border border-gray-alpha-400">
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

const BLANK = { name: '', instructions: '', sections: [{ heading: 'Summary', instructions: '' }] };

export function NewTemplateView({ initialData }: { initialData?: InitialNew }) {
  const shell = useShellData();
  const workspace = initialData?.workspace ?? shell.workspace;
  return <NewTemplate key={workspace.id} initialData={initialData} workspace={workspace} />;
}

function NewTemplate({
  initialData,
  workspace,
}: {
  initialData?: InitialNew;
  workspace: Workspace;
}) {
  const { client } = useWorkspaceHost();
  const load = useCallback(() => client.templates.list(workspace.id), [client, workspace.id]);
  const { data, error, retry } = useTemplateResource<Pick<TemplateList, 'canCreate'>>(
    initialData,
    load,
  );
  if (!data) return <TemplateLoading error={error} retry={retry} />;
  return (
    <PageContainer className="gap-6">
      <h1 className="sr-only">New template</h1>
      <div className="flex items-center gap-2 text-label-13 text-gray-900">
        <TemplatesBackLink />
        <span aria-hidden>·</span>
        <span>New in {workspace.name}</span>
      </div>
      {data.canCreate ? (
        <TemplateEditor mode="create" workspaceId={workspace.id} initial={BLANK} />
      ) : (
        <EmptyState
          icon={IconLock}
          title="You can’t create templates here"
          titleAs="h2"
          description={`Viewers of ${workspace.name} can use templates but not create them.`}
        />
      )}
    </PageContainer>
  );
}
