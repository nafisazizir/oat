import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { LayoutTemplateIcon, PlusIcon } from 'lucide-react';
import type { Metadata, Route } from 'next';
import Link from 'next/link';

import { EmptyState, PageContainer, PageHeader, SectionHeading } from '@/components/page';
import { TemplateIcon } from '@/components/templates/template-icon';
import type { TemplateDto } from '@/lib/templates';
import { loadTemplateList } from '@/server/templates/pages';

export const metadata: Metadata = { title: 'Templates' };

function TemplateCard({ template }: { template: TemplateDto }) {
  return (
    <li>
      <Link
        href={`/templates/${template.id}` as Route}
        className="flex h-full gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors duration-fast outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="template-card"
      >
        <TemplateIcon id={template.id} />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{template.name}</span>
            {template.isBuiltin && <Badge variant="outline">Built-in</Badge>}
          </div>
          {template.instructions && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{template.instructions}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {template.sections.map((s) => s.heading).join(' · ')}
          </p>
        </div>
      </Link>
    </li>
  );
}

export default async function TemplatesPage() {
  const { builtins, custom, canCreate, workspace } = await loadTemplateList();
  const customHeading = workspace.kind === 'personal' ? 'Your templates' : `${workspace.name}`;

  return (
    <PageContainer>
      <PageHeader
        title="Templates"
        description="Templates shape how Oat turns your notes and the transcript into clean notes."
      >
        {canCreate && (
          <Button asChild>
            <Link href="/templates/new">
              <PlusIcon />
              New template
            </Link>
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
          <EmptyState
            icon={LayoutTemplateIcon}
            title="No custom templates yet"
            description={
              canCreate
                ? 'Open a built-in and duplicate it, or start from scratch.'
                : 'Members of this workspace can create templates; you can use the built-ins.'
            }
          >
            {canCreate && (
              <Button variant="outline" asChild>
                <Link href="/templates/new">
                  <PlusIcon />
                  New template
                </Link>
              </Button>
            )}
          </EmptyState>
        )}
      </section>
    </PageContainer>
  );
}
