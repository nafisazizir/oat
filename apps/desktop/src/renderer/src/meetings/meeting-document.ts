import { sameDocumentContent } from '@oat/core/sync';
import type { OatClient } from '@oat/client';
import type { DocumentWriteAdapter } from '@oat/feature-ui/document';
import type { meetingAssistantHandle } from './meeting-assistant';

export function meetingDocumentAdapter({
  documentId,
  client,
  assistant,
  readOnlyRefresh,
}: {
  documentId: string;
  client: OatClient;
  assistant: ReturnType<typeof meetingAssistantHandle>;
  readOnlyRefresh?: () => Promise<unknown>;
}): DocumentWriteAdapter {
  return {
    settle: assistant.settle,
    currentVersion: assistant.currentVersion,
    prepareApply() {
      if (readOnlyRefresh)
        return async () => {
          await readOnlyRefresh();
        };
      const apply = assistant.prepareApply!();
      return async (next) => {
        const remote = await client.documents.get(documentId);
        if (
          remote.version !== next.version ||
          !sameDocumentContent(remote.contentJson, next.contentJson)
        )
          throw new Error('This note changed again. Reload it before applying this version.');
        await apply(next);
      };
    },
    async useBody(contentJson) {
      if (readOnlyRefresh) throw new Error('This note is read-only.');
      if (!(await assistant.settle())) throw new Error('Your latest edits aren’t saved yet.');
      await assistant.prepareApply!()({ version: assistant.currentVersion(), contentJson });
    },
  };
}
