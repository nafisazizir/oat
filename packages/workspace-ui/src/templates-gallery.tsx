'use client';

import type { TemplateDto, TemplateList } from '@oat/services/dto/templates';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { IconLayout, IconPlus } from '@tabler/icons-react';
import { useCallback } from 'react';
import { useWorkspaceHost } from './host';
import { EmptyState, PageContainer, PageHeader, SectionHeading } from './page';
import { useShellData } from './shell-data';
import { TemplateIcon } from './template-icon';
import { TemplateLoading, useTemplateResource } from './template-resource';

type Props = { initialData?: TemplateList; workspace?: { id: string; name: string } };

function TemplateCard({ template }: { template: TemplateDto }) {
  const { Link } = useWorkspaceHost();
  return (
    <li>
      <Link
        route={{ view: 'template', id: template.id }}
        className="flex h-full flex-col gap-4 rounded-lg border border-gray-alpha-400 bg-background-100 p-5 transition-colors outline-none hover:border-gray-alpha-500 hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50"
        data-testid="template-card"
      >
        <TemplateIcon id={template.id} />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="truncate text-heading-16 text-gray-1000">{template.name}</span>
            {template.isBuiltin && <Badge variant="outline">Built-in</Badge>}
          </div>
          {template.instructions && (
            <p className="line-clamp-2 text-copy-14 text-gray-900">{template.instructions}</p>
          )}
          <p className="truncate text-copy-13 text-gray-900">
            {template.sections.map((s) => s.heading).join(' · ')}
          </p>
        </div>
      </Link>
    </li>
  );
}

export function TemplatesGallery(props: Props) {
  const shell = useShellData();
  const workspace = props.workspace ?? shell.workspace;
  return <Gallery key={workspace.id} {...props} workspace={workspace} />;
}

function Gallery({ initialData, workspace }: Props & { workspace: { id: string; name: string } }) {
  const { client, Link } = useWorkspaceHost();
  const load = useCallback(() => client.templates.list(workspace.id), [client, workspace.id]);
  const { data, error, retry } = useTemplateResource(initialData, load);
  if (!data) return <TemplateLoading error={error} retry={retry} />;
  const { builtins, custom, canCreate } = data;
  const create = (
    <Button
      variant="secondary"
      role="link"
      nativeButton={false}
      render={<Link route={{ view: 'template-new' }} />}
    >
      <IconPlus data-icon="inline-start" />
      New template
    </Button>
  );
  return (
    <PageContainer className="max-w-4xl gap-8">
      <PageHeader
        title="Templates"
        description="Templates shape how Oat turns your notes and the transcript into clean notes."
      >
        {canCreate && create}
      </PageHeader>
      <section className="flex flex-col gap-3" aria-labelledby="builtin-heading">
        <div id="builtin-heading">
          <SectionHeading>Built-in</SectionHeading>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {builtins.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="custom-heading">
        <div id="custom-heading">
          <SectionHeading>{workspace.name}</SectionHeading>
        </div>
        {custom.length ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {custom.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={IconLayout}
            title="No custom templates yet"
            description={
              canCreate
                ? 'Open a built-in and duplicate it, or start from scratch.'
                : 'Members of this workspace can create templates; you can use the built-ins.'
            }
          >
            {canCreate && create}
          </EmptyState>
        )}
      </section>
    </PageContainer>
  );
}
