import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { IconLayout, IconPlus } from '@tabler/icons-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';

import { PageContainer, PageHeader, SectionHeading } from '@/components/page';
import { TemplateIcon } from '@/components/templates/template-icon';
import type { TemplateDto } from '@/lib/templates';
import { loadTemplateList } from '@/server/templates/pages';

export const metadata: Metadata = { title: 'Templates' };

function TemplateCard({ template }: { template: TemplateDto }) {
  return (
    <li>
      <Link
        href={`/templates/${template.id}` as Route}
        className="flex h-full gap-3 rounded-xl border border-gray-alpha-400 p-4 transition-colors duration-100 outline-none hover:border-gray-alpha-500 hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50"
        data-testid="template-card"
      >
        <TemplateIcon id={template.id} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-heading-14 text-gray-1000">{template.name}</span>
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

export default async function TemplatesPage() {
  const { builtins, custom, canCreate, workspace } = await loadTemplateList();
  const customHeading = workspace.name;

  return (
    <PageContainer>
      <PageHeader
        title="Templates"
        description="Templates shape how Oat turns your notes and the transcript into clean notes."
      >
        {canCreate && (
          <Button role="link" nativeButton={false} render={<Link href="/templates/new" />}>
            <IconPlus data-icon="inline-start" />
            New template
          </Button>
        )}
      </PageHeader>

      <section className="flex flex-col gap-3" aria-labelledby="builtin-heading">
        <div id="builtin-heading">
          <SectionHeading>Built-in</SectionHeading>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {builtins.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="custom-heading">
        <div id="custom-heading">
          <SectionHeading>{customHeading}</SectionHeading>
        </div>
        {custom.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {custom.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </ul>
        ) : (
          <Empty className="border border-dashed border-gray-alpha-400">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconLayout />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={3}>
                No custom templates yet
              </EmptyTitle>
              <EmptyDescription>
                {canCreate
                  ? 'Open a built-in and duplicate it, or start from scratch.'
                  : 'Members of this workspace can create templates; you can use the built-ins.'}
              </EmptyDescription>
            </EmptyHeader>
            {canCreate && (
              <EmptyContent>
                <Button
                  variant="outline"
                  role="link"
                  nativeButton={false}
                  render={<Link href="/templates/new" />}
                >
                  <IconPlus data-icon="inline-start" />
                  New template
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </section>
    </PageContainer>
  );
}
