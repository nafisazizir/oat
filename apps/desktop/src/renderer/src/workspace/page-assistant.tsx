import { DocumentAssistant, useRegisterOpenDocument } from '@oat/feature-ui/assistant';
import { PageEditor, PageEditorSurface, usePageEditor } from '@oat/workspace-ui/page-editor';
import type { ComponentProps } from 'react';

type DocumentDetail = ComponentProps<typeof PageEditor>['document'];

export function AssistantPageEditor({
  document,
  workspace,
}: {
  document: DocumentDetail;
  workspace: { name: string };
}) {
  return (
    <DocumentAssistant
      key={document.id}
      documentId={document.id}
      workspaceId={document.workspaceId}
      available={document.deletedAt === null}
      transcript={null}
      focus={{}}
    >
      <PageEditor document={document} workspace={workspace}>
        <EditorBridge />
        <PageEditorSurface />
      </PageEditor>
    </DocumentAssistant>
  );
}

function EditorBridge() {
  const { doc, autosave, editorRef, setContent, setUpdatedAt } = usePageEditor();
  useRegisterOpenDocument(doc.id, {
    settle: autosave.settle,
    editor: () => editorRef.current,
    adopt(next) {
      autosave.adopt(next);
      setUpdatedAt(new Date().toISOString());
    },
    replace(next) {
      autosave.adopt(next);
      setContent(next.contentJson);
      setUpdatedAt(new Date().toISOString());
    },
  });
  return null;
}
