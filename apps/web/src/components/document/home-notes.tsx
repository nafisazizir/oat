'use client';
import { HomeDocuments, type HomeLinkProps } from '@oat/workspace-ui/home-documents';
import { homeDocuments } from '@oat/workspace-ui/home-model';
import Link from 'next/link';
import type { DocumentNode } from '@/lib/tree';
import { useHydrated } from '@/lib/use-hydrated';

function HomeLink({ document, children, className }: HomeLinkProps) {
  return (
    <Link href={`/d/${document.id}`} data-testid="home-note-row" className={className}>
      {children}
    </Link>
  );
}
export function HomeNotes({ documents }: { documents: DocumentNode[] }) {
  const hydrated = useHydrated();
  return (
    <HomeDocuments
      documents={homeDocuments(documents)}
      Link={HomeLink}
      timeZone={hydrated ? undefined : 'UTC'}
    />
  );
}
