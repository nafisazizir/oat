'use client';

import type { JSONContent } from '@oat/editor';
import { toast } from 'sonner';
import { EnhanceError } from './enhance-controls';
import { EnhancePreview } from './enhance-preview';
import { useEnhanceControls } from './enhance-toolbar';
import { useEnhancement } from './use-enhancement';
import { noteToastId, useNoteVersions } from './use-note-versions';

export type DocumentBody = { version: number; contentJson: JSONContent; updatedAt: string };
export type ApplyDocument = (document: DocumentBody) => Promise<void>;
export type DocumentWriteAdapter = {
  settle(): Promise<boolean>;
  currentVersion(): number;
  prepareApply(): ApplyDocument;
  useBody(content: JSONContent): Promise<void>;
};

export function useDocumentEnhancement({
  documentId,
  loadedVersion,
  enabled,
  editable,
  host,
}: {
  documentId: string;
  loadedVersion: number;
  enabled: boolean;
  editable: boolean;
  host: DocumentWriteAdapter;
}) {
  const versions = useNoteVersions({
    documentId,
    enabled: enabled && editable,
    settle: host.settle,
    currentVersion: host.currentVersion,
    prepareApply: host.prepareApply,
    onRestored: (doc) => host.prepareApply()(doc),
  });
  const enhancement = useEnhancement({
    documentId,
    loadedVersion,
    enabled,
    beforeStart: host.settle,
    prepareApply: host.prepareApply,
    onCompleted: async ({ enhancement: run, doc }, apply) => {
      if (run.applied && run.documentVersion !== null) {
        if (!apply) throw new Error('Reload this note before applying the enhanced version.');
        await apply({
          version: run.documentVersion,
          contentJson: doc,
          updatedAt: run.completedAt ?? new Date().toISOString(),
        });
        void versions.refresh();
        toast.success('Notes enhanced', {
          id: noteToastId(documentId),
          description: 'Your own lines stay in full ink; what the AI added is softer.',
          ...(editable ? { action: { label: 'Undo', onClick: () => versions.undo() } } : {}),
        });
      } else {
        void versions.refresh();
        if (editable)
          toast('This note changed while the AI was writing', {
            id: `enhanced-${run.id}`,
            description: 'Your edits were kept. The enhanced version is saved too.',
            duration: Infinity,
            action: {
              label: 'Use enhanced version',
              onClick: () => {
                void host.useBody(doc).catch((error: unknown) =>
                  toast.error('Couldn’t use the enhanced version', {
                    description: error instanceof Error ? error.message : 'Please try again.',
                  }),
                );
              },
            },
          });
      }
    },
  });
  const controls = useEnhanceControls({ enhancement, versions });
  return {
    enhancement,
    versions,
    enhance: controls.enhanceButton,
    historyAction: controls.historyAction,
    streaming: enhancement.state.phase === 'streaming',
    beforeEditor: (
      <>
        <EnhanceError enhancement={enhancement} />
        {enhancement.state.phase === 'streaming' && (
          <EnhancePreview output={enhancement.state.preview} />
        )}
        {enabled && editable && controls.dialogs}
      </>
    ),
  };
}
