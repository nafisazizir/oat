'use client';

import type { JSONContent } from '@oat/editor';
import { useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createOatClient, fetchTransport } from '@oat/client';
import { DocumentEditorSurface, noteToastId } from '@oat/feature-ui/document';
import type { DocumentDetail } from '@/lib/api-types';
import type { WorkspaceAudience } from '@/lib/workspace';
import { PageEditor, usePageEditor } from '@oat/workspace-ui/page-editor';
import type { SaveDocument } from '@oat/workspace-ui/use-autosave';
import { TopBarActions } from '@/components/app-shell/top-bar';
import { PipelineStatus } from '@/components/pipeline/pipeline-status';

const client = createOatClient(fetchTransport());
const keepaliveClient = createOatClient(
  fetchTransport({ fetch: (input, init) => fetch(input, { ...init, keepalive: true }) }),
);
const saveDocument: SaveDocument = (id, input, options) =>
  (options?.keepalive ? keepaliveClient : client).documents.update(id, input);
const reloadDocument = () => window.location.reload();
type Extras = { meta?: ReactNode; headerActions?: ReactNode; overflowActions?: ReactNode };

export function DocumentEditor({
  document,
  workspace,
  ...extras
}: { document: DocumentDetail; workspace: WorkspaceAudience } & Extras) {
  const onSaved = useCallback(
    (_saved: DocumentDetail, patch: { contentJson?: JSONContent }) => {
      if (patch.contentJson !== undefined) toast.dismiss(noteToastId(document.id));
    },
    [document.id],
  );
  return (
    <PageEditor
      document={document}
      workspace={workspace}
      save={saveDocument}
      onSaved={onSaved}
      onReload={reloadDocument}
    >
      <WebSurface {...extras} />
    </PageEditor>
  );
}

function WebSurface(extras: Extras) {
  const router = useRouter();
  const { doc, editable } = usePageEditor();
  return (
    <DocumentEditorSurface
      {...extras}
      Actions={TopBarActions}
      onOpenIntegrations={() => router.push('/settings/integrations')}
      renderPipeline={(follow) => (
        <PipelineStatus documentId={doc.id} canRun={editable} onEnhancing={follow} />
      )}
    />
  );
}
