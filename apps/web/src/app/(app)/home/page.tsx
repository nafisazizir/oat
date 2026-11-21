import type { Metadata } from 'next';
import { Suspense } from 'react';

import { UpcomingMeetings } from '@/components/calendar/upcoming-meetings';
import { HomeNotes } from '@/components/document/home-notes';
import { PageContainer } from '@/components/page';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const { documents } = await getShellData();
  return (
    <PageContainer className="max-w-[744px] gap-8 py-8 sm:py-8">
      <h1 className="sr-only">Home</h1>
      <Suspense fallback={null}>
        <UpcomingMeetings />
      </Suspense>
      <HomeNotes documents={documents.filter((doc) => doc.kind !== 'folder')} />
    </PageContainer>
  );
}
