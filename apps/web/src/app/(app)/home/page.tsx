import type { Metadata } from 'next';
import { Suspense } from 'react';

import { UpcomingMeetings } from '@/components/calendar/upcoming-meetings';
import { HomeNotes } from '@/components/document/home-notes';
import { HomeLayout } from '@/components/page';
import { getShellData } from '@/server/shell';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const { documents } = await getShellData();
  return (
    <HomeLayout>
      <Suspense fallback={null}>
        <UpcomingMeetings />
      </Suspense>
      <HomeNotes documents={documents.filter((doc) => doc.kind !== 'folder')} />
    </HomeLayout>
  );
}
