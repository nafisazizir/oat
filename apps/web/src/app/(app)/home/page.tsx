import { Button } from '@oat/ui/components/button';
import { FileTextIcon, FolderIcon, NotebookPenIcon, UsersIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { NewNoteButton } from '@/components/app-shell/new-note-button';
import { EmptyState, PageContainer, PageHeader, SectionHeading } from '@/components/page';
import { formatDay } from '@/lib/format';
import { getShellData, listRecentMeetings, listRecentPages } from '@/server/shell';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const [{ workspace: currentWorkspace }, recentMeetings, recentPages] = await Promise.all([
    getShellData(),
    listRecentMeetings(),
    listRecentPages(4),
  ]);

  return (
    <PageContainer>
      <PageHeader title="Home" description={`Your meetings and notes in ${currentWorkspace.name}.`}>
        {/* The empty state carries the call to action until there are notes. */}
        {recentMeetings.length > 0 && <NewNoteButton size="lg" className="hidden sm:inline-flex" />}
      </PageHeader>

      <section aria-labelledby="recent-notes" className="flex flex-col gap-3">
        <SectionHeading>
          <span id="recent-notes">Recent notes</span>
        </SectionHeading>
        {recentMeetings.length === 0 ? (
          <EmptyState
            icon={NotebookPenIcon}
            title="No meeting notes yet"
            description="Start a note when your next call begins. Oat listens alongside you and turns your rough notes and the transcript into clean notes."
          >
            <NewNoteButton />
            <Button variant="ghost" asChild>
              <Link href="/d/getting-started">Read Getting started</Link>
            </Button>
          </EmptyState>
        ) : null}
      </section>

      <section aria-labelledby="recent-pages" className="flex flex-col gap-3">
        <SectionHeading>
          <span id="recent-pages">Jump back in</span>
        </SectionHeading>
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {recentPages.map((doc) => {
            const Icon =
              doc.kind === 'folder'
                ? FolderIcon
                : doc.visibility === 'workspace'
                  ? UsersIcon
                  : FileTextIcon;
            return (
              <li key={doc.id}>
                <Link
                  href={`/d/${doc.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{doc.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {doc.visibility === 'private' ? 'Private' : 'Shared'} ·{' '}
                    {formatDay(doc.updatedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </PageContainer>
  );
}
