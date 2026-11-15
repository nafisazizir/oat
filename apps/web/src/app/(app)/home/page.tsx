import { FileTextIcon, NotebookPenIcon, UsersIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { NewNoteButton } from '@/components/app-shell/new-note-button';
import {
  UpcomingMeetings,
  UpcomingMeetingsSkeleton,
} from '@/components/calendar/upcoming-meetings';
import { EmptyState, PageContainer, PageHeader, SectionHeading } from '@/components/page';
import { formatDay } from '@/lib/format';
import { type DocumentNode, titleOf } from '@/lib/tree';
import { getShellData, listRecentMeetings, listRecentPages } from '@/server/shell';

export const metadata: Metadata = { title: 'Home' };

function DocumentList({ documents }: { documents: readonly DocumentNode[] }) {
  return (
    <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
      {documents.map((doc) => {
        const Icon =
          doc.kind === 'meeting'
            ? NotebookPenIcon
            : doc.visibility === 'private'
              ? FileTextIcon
              : UsersIcon;
        return (
          <li key={doc.id}>
            <Link
              href={`/d/${doc.id}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{titleOf(doc)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {doc.visibility === 'private' ? 'Private' : 'Shared'} · {formatDay(doc.updatedAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default async function HomePage() {
  const [{ workspace: currentWorkspace }, recentMeetings, recentPages] = await Promise.all([
    getShellData(),
    listRecentMeetings(5),
    listRecentPages(4),
  ]);

  return (
    <PageContainer>
      <PageHeader title="Home" description={`Your meetings and notes in ${currentWorkspace.name}.`}>
        {/* The empty state carries the call to action until there are notes. */}
        {recentMeetings.length > 0 && <NewNoteButton size="lg" className="hidden sm:inline-flex" />}
      </PageHeader>

      {/* Streams in: a slow calendar never holds up the rest of Home. */}
      <Suspense fallback={<UpcomingMeetingsSkeleton />}>
        <UpcomingMeetings />
      </Suspense>

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
          </EmptyState>
        ) : (
          <DocumentList documents={recentMeetings} />
        )}
      </section>

      <section aria-labelledby="recent-pages" className="flex flex-col gap-3">
        <SectionHeading>
          <span id="recent-pages">Jump back in</span>
        </SectionHeading>
        {recentPages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Pages you edit show up here. Add one with the + next to Private in the sidebar.
          </p>
        ) : (
          <DocumentList documents={recentPages} />
        )}
      </section>
    </PageContainer>
  );
}
