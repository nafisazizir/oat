import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@oat/ui/components/item';
import { IconFileText, IconNotebook } from '@tabler/icons-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { NewNoteButton } from '@/components/app-shell/new-note-button';
import {
  UpcomingMeetings,
  UpcomingMeetingsSkeleton,
} from '@/components/calendar/upcoming-meetings';
import { PageContainer } from '@/components/page';
import { formatDay } from '@/lib/format';
import { type DocumentNode, titleOf } from '@/lib/tree';
import { getShellData, listRecentMeetings, listRecentPages } from '@/server/shell';

export const metadata: Metadata = { title: 'Home' };

function DocumentList({ documents }: { documents: readonly DocumentNode[] }) {
  return (
    <ul className="flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-100">
      {documents.map((doc) => {
        const Icon = doc.kind === 'meeting' ? IconNotebook : IconFileText;
        return (
          <li key={doc.id}>
            <Item
              render={<Link href={`/d/${doc.id}`} />}
              className="rounded-none py-3 text-gray-1000"
            >
              <ItemMedia variant="icon" className="text-gray-900">
                <Icon aria-hidden="true" />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>{titleOf(doc)}</ItemTitle>
              </ItemContent>
              <span className="shrink-0 text-label-12 text-gray-900">
                {formatDay(doc.updatedAt)}
              </span>
            </Item>
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
      <header className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-4">
          <h1 className="text-heading-32 text-gray-1000">Home</h1>
        </div>
        <p className="text-copy-14 text-gray-900">
          Your meetings and notes in {currentWorkspace.name}.
        </p>
      </header>

      {/* Streams in: a slow calendar never holds up the rest of Home. */}
      <Suspense fallback={<UpcomingMeetingsSkeleton />}>
        <UpcomingMeetings />
      </Suspense>

      <section aria-labelledby="recent-notes" className="flex flex-col gap-3">
        <h2 id="recent-notes" className="text-heading-16 text-gray-1000">
          Recent notes
        </h2>
        {recentMeetings.length === 0 ? (
          <Empty className="border border-gray-alpha-400 text-gray-1000">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconNotebook aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No meeting notes yet</EmptyTitle>
              <EmptyDescription>
                Start a note for your next call. Your notes and transcript stay together.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <NewNoteButton />
            </EmptyContent>
          </Empty>
        ) : (
          <DocumentList documents={recentMeetings} />
        )}
      </section>

      <section aria-labelledby="recent-pages" className="flex flex-col gap-3">
        <h2 id="recent-pages" className="text-heading-16 text-gray-1000">
          Jump back in
        </h2>
        {recentPages.length === 0 ? (
          <p className="text-copy-14 text-gray-900">Pages you edit show up here.</p>
        ) : (
          <DocumentList documents={recentPages} />
        )}
      </section>
    </PageContainer>
  );
}
