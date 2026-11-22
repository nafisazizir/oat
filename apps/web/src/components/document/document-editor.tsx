'use client';

import type { JSONContent } from '@oat/editor';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { createOatClient, fetchTransport } from '@oat/client';
import type { DocumentDetail } from '@/lib/api-types';
import type { WorkspaceAudience } from '@/lib/workspace';
import {
  PageEditor,
  PageEditorSurface,
  MoreActions,
  usePageEditor,
} from '@oat/workspace-ui/page-editor';
import type { SaveDocument } from '@oat/workspace-ui/use-autosave';
import { announceDocumentChange } from '@oat/workspace-ui/document-events';
import { TopBarActions } from '@/components/app-shell/top-bar';
import { useRegisterOpenDocument } from '@/components/assistant/open-document';
import { NotionExportButton } from '@/components/notion/notion-export-button';
import { PipelineStatus } from '@/components/pipeline/pipeline-status';
import { useTaskAssignees } from '@oat/feature-ui/tasks';
import { EnhanceError } from './enhance/enhance-controls';
import { EnhancePreview } from './enhance/enhance-preview';
import { EnhanceToolbar } from './enhance/enhance-toolbar';
import { useEnhancement } from './enhance/use-enhancement';
import { noteToastId, useNoteVersions } from './enhance/use-note-versions';

const client = createOatClient(fetchTransport());
const keepaliveClient = createOatClient(
  fetchTransport({
    fetch: (input, init) => fetch(input, { ...init, keepalive: true }),
  }),
);
const saveDocument: SaveDocument = (id, input, options) =>
  (options?.keepalive ? keepaliveClient : client).documents.update(id, input);
const reloadDocument = () => window.location.reload();

type Extras = {
  meta?: React.ReactNode;
  headerActions?: React.ReactNode;
  overflowActions?: React.ReactNode;
};

export function DocumentEditor({
  document,
  workspace,
  ...extras
}: {
  document: DocumentDetail;
  workspace: WorkspaceAudience;
} & Extras) {
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
      <WebPageEditor {...extras} />
    </PageEditor>
  );
}

function WebPageEditor({ meta, headerActions, overflowActions }: Extras) {
  const { doc, title, autosave, setContent, setUpdatedAt, editorRef, editable, trashed } =
    usePageEditor();
  const secondaryActions = (history: React.ReactNode) => (
    <NotionExportButton
      documentId={doc.id}
      beforeSend={autosave.flush}
      fallback={
        history || overflowActions ? (
          <MoreActions>
            {history}
            {overflowActions}
          </MoreActions>
        ) : null
      }
      wrap={(control) => (
        <MoreActions>
          {history}
          {control}
          {overflowActions}
        </MoreActions>
      )}
    />
  );
  // The assistant panel (6.4) saves pending edits before approving a change and shows the result here.
  useRegisterOpenDocument(doc.id, {
    settle: autosave.settle,
    adopt: (next) => {
      autosave.adopt(next);
      setUpdatedAt(new Date().toISOString());
    },
    replace: (next) => {
      autosave.adopt(next);
      setContent(next.contentJson);
      setUpdatedAt(new Date().toISOString());
    },
    editor: () => editorRef.current,
  });

  const isMeeting = doc.kind === 'meeting';
  /** The server wrote a new body (enhancement applied, version restored, undo): show it, save on top of it. */
  const showServerBody = (next: {
    version: number;
    contentJson: JSONContent;
    updatedAt: string;
  }) => {
    autosave.adopt(next);
    setContent(next.contentJson);
    setUpdatedAt(next.updatedAt);
    announceDocumentChange({ id: doc.id, version: next.version, title });
  };
  // Versions, restore and undo (4.5): editors only.
  const versions = useNoteVersions({
    documentId: doc.id,
    enabled: isMeeting && editable,
    settle: autosave.settle,
    currentVersion: autosave.currentVersion,
    onRestored: showServerBody,
  });
  const enhancement = useEnhancement({
    documentId: doc.id,
    loadedVersion: doc.version,
    enabled: isMeeting && !trashed,
    beforeStart: autosave.settle,
    onCompleted: ({ enhancement: run, doc: enhanced }) => {
      void versions.refresh();
      if (run.applied && run.documentVersion !== null) {
        showServerBody({
          version: run.documentVersion,
          contentJson: enhanced,
          updatedAt: run.completedAt ?? new Date().toISOString(),
        });
        toast.success('Notes enhanced', {
          id: noteToastId(doc.id),
          description: 'Your own lines stay in full ink; what the AI added is softer.',
          ...(editable ? { action: { label: 'Undo', onClick: () => versions.undo() } } : {}),
        });
        return;
      }
      // D-20: edited while the AI was writing — keep the user's body, offer the enhanced version (editors).
      if (!editable) return;
      toast('This note changed while the AI was writing', {
        id: `enhanced-${run.id}`,
        description: 'Your edits were kept. The enhanced version is saved too.',
        duration: Infinity,
        action: {
          label: 'Use enhanced version',
          onClick: () => {
            setContent(enhanced);
            autosave.queue({ contentJson: enhanced });
          },
        },
      });
    },
  });

  const streaming = enhancement.state.phase === 'streaming';
  const taskAssignees = useTaskAssignees(doc.id);
  return (
    <PageEditorSurface
      meta={meta}
      headerActions={headerActions}
      Actions={TopBarActions}
      statusExtra={
        isMeeting && (
          <PipelineStatus documentId={doc.id} canRun={editable} onEnhancing={enhancement.follow} />
        )
      }
      secondaryActions={
        editable && isMeeting ? (
          <EnhanceToolbar
            enhancement={enhancement}
            versions={versions}
            workspaceId={doc.workspaceId}
            renderSecondaryActions={secondaryActions}
          />
        ) : (
          secondaryActions(null)
        )
      }
      beforeEditor={
        <>
          <EnhanceError enhancement={enhancement} />
          {enhancement.state.phase === 'streaming' && (
            <EnhancePreview output={enhancement.state.preview} />
          )}
        </>
      }
      streaming={streaming}
      taskAssignees={taskAssignees}
    />
  );
}
