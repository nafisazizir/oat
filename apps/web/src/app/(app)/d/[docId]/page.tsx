import { Badge } from '@oat/ui/components/badge';
import { FileTextIcon, FolderIcon, LockIcon, PenLineIcon, UsersIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState, PageContainer, PageHeader } from '@/components/page';
import { formatDay } from '@/lib/format';
import { getDocument, getShellData, listChildren } from '@/server/shell';

type Props = { params: Promise<{ docId: string }> };

/** Dev/test hook for the error boundary (`/d/__error`); a normal 404 in production. */
const ERROR_PROBE_ID = '__error';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { docId } = await params;
  return { title: (await getDocument(docId))?.title ?? 'Not found' };
}

export default async function DocumentPage({ params }: Props) {
  const { docId } = await params;
  if (docId === ERROR_PROBE_ID && process.env.NODE_ENV !== 'production') {
    throw new Error('Error-boundary probe: this page always fails in development.');
  }
  const [doc, { workspace: currentWorkspace }] = await Promise.all([
    getDocument(docId),
    getShellData(),
  ]);
  if (!doc) notFound();

  const isPrivate = doc.visibility === 'private';
  const children = doc.kind === 'folder' ? await listChildren(doc) : [];

  return (
    <PageContainer>
      <PageHeader
        title={doc.title}
        eyebrow={
          <>
            <Badge variant="secondary" className="gap-1">
              {isPrivate ? <LockIcon /> : <UsersIcon />}
              {isPrivate ? 'Private' : `Shared with ${currentWorkspace.name}`}
            </Badge>
            <span>Edited {formatDay(doc.updatedAt)}</span>
          </>
        }
      />

      {doc.kind === 'folder' ? (
        <ul className="flex flex-col gap-1">
          {children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/d/${child.id}`}
                className="-mx-3 flex items-center gap-3 rounded-lg px-3 py-2 text-base transition-colors duration-fast hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                {child.kind === 'folder' ? (
                  <FolderIcon className="size-4 text-muted-foreground" />
                ) : (
                  <FileTextIcon className="size-4 text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{child.title}</span>
                <span className="text-xs text-muted-foreground">{formatDay(child.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={PenLineIcon}
          title="The editor is on its way"
          description="This page will open in Oat's block editor, with headings, checklists, mentions and your meeting notes side by side."
        />
      )}
    </PageContainer>
  );
}
