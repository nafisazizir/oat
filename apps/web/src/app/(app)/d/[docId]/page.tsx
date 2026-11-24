import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { BlockFocus } from '@/components/document/block-focus';
import { DocumentAssistant } from '@/components/assistant/document-assistant';
import { MeetingEventLine } from '@/components/calendar/meeting-event-line';
import { ConflictBannerSlot } from '@/components/document/conflict-banner-slot';
import { FolderView } from '@oat/workspace-ui/folder-view';
import { DocumentEditor } from '@/components/document/document-editor';
import { MeetingNote } from '@/components/meeting/meeting-note';
import { parseDeepLink, wantsTranscript } from '@/lib/transcript';
import { titleOf } from '@/lib/tree';
import {
  getShellData,
  loadDocumentMeeting,
  loadDocumentPage,
  loadDocumentTranscript,
} from '@/server/shell';

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
  // The meeting side (3.4) loads alongside: one round trip less before the page streams.
  const [data, shell, meetingInfo] = await Promise.all([
    loadDocumentPage(docId),
    getShellData(),
    loadDocumentMeeting(docId),
  ]);
  if (!data) notFound();
  // The item's own workspace (it can be opened from a link while another one is active).
  const itemWorkspaceId =
    data.type === 'document' ? data.document.workspaceId : data.folder.workspaceId;
  const workspace = shell.workspaces.find((w) => w.id === itemWorkspaceId) ?? shell.workspace;

  if (data.type === 'document') {
    const doc = data.document;
    // `?t=<s>&seg=<id>` (citations, transcript search hits) opens the transcript at that moment (6.4).
    const focus = parseDeepLink(await searchParams);
    // A meeting note (3.4) shows its header and transcript panel itself (the panel opens at a deep link's
    // moment); the assistant's own transcript reader is only for anything else.
    const meeting = doc.kind === 'meeting' ? meetingInfo : null;
    const transcript =
      !meeting && doc.kind === 'meeting' && wantsTranscript(focus)
        ? await loadDocumentTranscript(doc.id)
        : null;
    return (
      <>
        <DocumentAssistant
          key={doc.id}
          documentId={doc.id}
          workspaceId={doc.workspaceId}
          available={doc.deletedAt === null}
          layout={meeting ? 'dock' : 'panel'}
          transcript={transcript}
          focus={focus}
        >
          {/* A conflicted copy (3.5): where it came from and how to resolve it. Streams in on its own. */}
          <Suspense fallback={null}>
            <ConflictBannerSlot documentId={doc.id} />
          </Suspense>
          {meeting ? (
            <MeetingNote
              key={doc.id}
              document={doc}
              workspace={workspace}
              initial={meeting}
              focus={focus}
              eventLine={
                // Keyed: rendered among the client header's children (React warns otherwise).
                <Suspense key="calendar-event" fallback={null}>
                  <MeetingEventLine documentId={doc.id} recorded={meeting.startedAt !== null} />
                </Suspense>
              }
            />
          ) : (
            <DocumentEditor key={doc.id} document={doc} workspace={workspace} />
          )}
        </DocumentAssistant>
        {/* `?block=<id>` links (My tasks): scroll to and highlight that block. */}
        <Suspense fallback={null}>
          <BlockFocus />
        </Suspense>
      </>
    );
  }

  return <FolderView folder={data.folder} children={data.children} workspace={workspace} />;
}
