import { Badge } from '@oat/ui/components/badge';
import {
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  LockIcon,
  NotebookPenIcon,
  UsersIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DocumentAssistant } from '@/components/assistant/document-assistant';
import { FolderActions } from '@/components/document/folder-actions';
import { DocumentEditor } from '@/components/document/document-editor';
import { EmptyState, PageContainer, PageHeader } from '@/components/page';
import { formatDay } from '@/lib/format';
import { parseDeepLink, wantsTranscript } from '@/lib/transcript';
import { titleOf } from '@/lib/tree';
import { getShellData, loadDocumentPage, loadDocumentTranscript } from '@/server/shell';

type Props = {
  params: Promise<{ docId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Dev/test hook for the error boundary (`/d/__error`); a normal 404 in production. */
const ERROR_PROBE_ID = '__error';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { docId } = await params;
  const data = await loadDocumentPage(docId);
  if (!data) return { title: 'Not found' };
  return {
    title:
      data.type === 'folder'
        ? titleOf({ title: data.folder.name, kind: 'folder' })
        : titleOf(data.document),
  };
}

/**
 * `/d/[id]`: a document (title + editor) or a folder (its contents). Anything the user can't read is a
 * plain 404, whether it exists or not (no existence leak for other people's private pages).
 */
export default async function DocumentPage({ params, searchParams }: Props) {
  const { docId } = await params;
  if (docId === ERROR_PROBE_ID && process.env.NODE_ENV !== 'production') {
    throw new Error('Error-boundary probe: this page always fails in development.');
  }
  const [data, shell] = await Promise.all([loadDocumentPage(docId), getShellData()]);
  if (!data) notFound();
  // The item's own workspace (it can be opened from a link while another one is active).
  const itemWorkspaceId =
    data.type === 'document' ? data.document.workspaceId : data.folder.workspaceId;
  const workspace = shell.workspaces.find((w) => w.id === itemWorkspaceId) ?? shell.workspace;

  if (data.type === 'document') {
    const doc = data.document;
    // `?t=<s>&seg=<id>` (citations, transcript search hits) opens the transcript at that moment (6.4).
    const focus = parseDeepLink(await searchParams);
    const transcript =
      doc.kind === 'meeting' && wantsTranscript(focus)
        ? await loadDocumentTranscript(doc.id)
        : null;
    return (
      <DocumentAssistant
        key={doc.id}
        documentId={doc.id}
        workspaceId={doc.workspaceId}
        available={doc.deletedAt === null}
        transcript={transcript}
        focus={focus}
      >
        <DocumentEditor key={doc.id} document={doc} workspaceName={workspace.name} />
      </DocumentAssistant>
    );
  }

  const { folder, children } = data;
  const isPrivate = folder.visibility === 'private';
  return (
    <PageContainer>
      <PageHeader
        title={titleOf({ title: folder.name, kind: 'folder' })}
        eyebrow={
          <>
            <Badge variant="secondary" className="gap-1">
              {isPrivate ? <LockIcon /> : <UsersIcon />}
              {isPrivate ? 'Private folder' : `Shared with ${workspace.name}`}
            </Badge>
            <span>Edited {formatDay(folder.updatedAt)}</span>
          </>
        }
      >
        {folder.access.edit && <FolderActions folderId={folder.id} />}
      </PageHeader>

      {children.length === 0 ? (
        <EmptyState
          icon={FolderOpenIcon}
          title="This folder is empty"
          description="Add a page here, or drag pages onto the folder in the sidebar."
        />
      ) : (
        <ul className="flex flex-col gap-1" data-testid="folder-contents">
          {children.map((child) => {
            const Icon =
              child.kind === 'folder'
                ? FolderIcon
                : child.kind === 'meeting'
                  ? NotebookPenIcon
                  : FileTextIcon;
            return (
              <li key={child.id}>
                <Link
                  href={`/d/${child.id}`}
                  className="-mx-3 flex items-center gap-3 rounded-lg px-3 py-2 text-base transition-colors duration-fast hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{titleOf(child)}</span>
                  {child.visibility === 'private' && !isPrivate && (
                    <LockIcon className="size-3.5 text-muted-foreground" aria-label="Only you" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDay(child.updatedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
