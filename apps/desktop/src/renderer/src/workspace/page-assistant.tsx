import { DocumentAssistant } from '@oat/feature-ui/assistant';
import { DocumentEditorSurface } from '@oat/feature-ui/document';
import { PageEditor } from '@oat/workspace-ui/page-editor';
import { useWorkspaceHost } from '@oat/workspace-ui/host';
import type { ComponentProps } from 'react';
import { bridge, call } from '../bridge';

type DocumentDetail = ComponentProps<typeof PageEditor>['document'];
const beforeNetwork = () => call('sync:now');
const openExternal = (url: string) => bridge().send('shell:open-external', { url });

export function AssistantPageEditor({
  document,
  workspace,
}: {
  document: DocumentDetail;
  workspace: { name: string };
}) {
  const host = useWorkspaceHost();
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
        <DocumentEditorSurface
          beforeNetwork={beforeNetwork}
          openExternal={openExternal}
          onOpenIntegrations={() => host.navigate({ view: 'settings', section: 'integrations' })}
        />
      </PageEditor>
    </DocumentAssistant>
  );
}
