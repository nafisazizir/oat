'use client';

import { useCallback, useMemo, type ComponentProps, type ReactNode } from 'react';
import { MoreActions, PageEditorSurface, usePageEditor } from '@oat/workspace-ui/page-editor';
import { announceDocumentChange } from '@oat/workspace-ui/document-events';
import { useRegisterOpenDocument } from './open-document';
import { useTaskAssignees } from './tasks-client';
import { NotionExportButton } from './notion-export-button';
import {
  useDocumentEnhancement,
  type DocumentBody,
  type DocumentWriteAdapter,
} from './document-enhancement';

export function DocumentEditorSurface({
  renderMeta,
  headerActions,
  overflowActions,
  Actions,
  renderPipeline,
  beforeNetwork,
  onOpenIntegrations,
  openExternal,
}: {
  renderMeta?(enhanceAction: ReactNode): ReactNode;
  headerActions?: ReactNode;
  overflowActions?: ReactNode;
  Actions?: ComponentProps<typeof PageEditorSurface>['Actions'];
  renderPipeline?(follow: () => void): ReactNode;
  beforeNetwork?(): Promise<unknown>;
  onOpenIntegrations(): void;
  openExternal?(url: string): void;
}) {
  const { doc, title, autosave, editorRef, setContent, setUpdatedAt, editable, trashed } =
    usePageEditor();
  const { settle: save, adopt, currentVersion, queue } = autosave;
  const settle = useCallback(async () => {
    if (!(await save())) return false;
    await beforeNetwork?.();
    return true;
  }, [save, beforeNetwork]);
  const show = useCallback(
    async (next: DocumentBody) => {
      adopt(next);
      setContent(next.contentJson);
      setUpdatedAt(next.updatedAt);
      announceDocumentChange({ id: doc.id, version: next.version, title });
    },
    [adopt, setContent, setUpdatedAt, doc.id, title],
  );
  const host = useMemo<DocumentWriteAdapter>(
    () => ({
      settle,
      currentVersion,
      prepareApply: () => show,
      async useBody(contentJson) {
        if (!(await settle())) throw new Error('Your latest edits aren’t saved yet.');
        setContent(contentJson);
        queue({ contentJson });
        if (!(await save()))
          throw new Error('Couldn’t save the enhanced version. Your edits are kept here.');
      },
    }),
    [settle, currentVersion, queue, save, show, setContent],
  );
  useRegisterOpenDocument(doc.id, {
    settle,
    editor: () => editorRef.current,
    adopt: (next) => {
      autosave.adopt(next);
      setUpdatedAt(new Date().toISOString());
    },
    replace: (next) => {
      autosave.adopt(next);
      setContent(next.contentJson);
      setUpdatedAt(new Date().toISOString());
    },
  });
  const meeting = doc.kind === 'meeting';
  const capabilities = useDocumentEnhancement({
    documentId: doc.id,
    loadedVersion: doc.version,
    enabled: meeting && !trashed,
    editable,
    host,
  });
  const secondary = (history: ReactNode, lifecycle: ReactNode) => (
    <NotionExportButton
      documentId={doc.id}
      beforeSend={settle}
      onOpenIntegrations={onOpenIntegrations}
      openExternal={openExternal}
      fallback={
        history || overflowActions || lifecycle ? (
          <MoreActions>
            {history}
            {overflowActions}
            {lifecycle}
          </MoreActions>
        ) : null
      }
      wrap={(control) => (
        <MoreActions>
          {history}
          {control}
          {overflowActions}
          {lifecycle}
        </MoreActions>
      )}
    />
  );
  const assignees = useTaskAssignees(doc.id);
  const enhanceAction = editable && meeting ? capabilities.enhance(doc.workspaceId) : null;
  return (
    <>
      {meeting && renderPipeline?.(capabilities.enhancement.follow)}
      <PageEditorSurface
        meta={renderMeta ? renderMeta(enhanceAction) : enhanceAction}
        headerActions={headerActions}
        Actions={Actions}
        renderSecondaryActions={(lifecycle) =>
          secondary(editable && meeting ? capabilities.historyAction : null, lifecycle)
        }
        beforeEditor={capabilities.beforeEditor}
        streaming={capabilities.streaming}
        taskAssignees={assignees}
      />
    </>
  );
}
