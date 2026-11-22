import type { JSONContent } from '@oat/editor';
import type { OpenDocumentHandle } from '@oat/feature-ui/open-document';
import { sameDocumentContent } from '@oat/core/sync';
import type { OatClient } from '@oat/client';
import { call } from '../bridge';
import type { NoteAutosave } from './note-autosave';

export function meetingAssistantHandle({
  documentId,
  autosave,
  client,
  adopt,
}: {
  documentId: string;
  autosave: NoteAutosave;
  client: OatClient;
  adopt(content: JSONContent): void;
}): Omit<OpenDocumentHandle, 'editor'> & { currentVersion(): number } {
  let version = 0;
  return {
    async settle() {
      await autosave.flush();
      if (autosave.dirty || !autosave.base) return false;
      await call('sync:now');
      const remote = await client.documents.get(documentId);
      const base = autosave.base;
      const settled =
        !autosave.dirty &&
        !!base &&
        remote.title === base.title &&
        sameDocumentContent(remote.contentJson, base.contentJson);
      if (settled) version = remote.version;
      return settled;
    },
    currentVersion: () => version,
    adopt: (doc) => adopt(doc.contentJson),
    replace: (doc) => adopt(doc.contentJson),
    prepareApply() {
      const base = autosave.base;
      if (!base || autosave.dirty) throw new Error('Your latest edits aren’t saved yet.');
      return async (doc) => {
        if (autosave.dirty) throw new Error('Your latest edits aren’t saved yet.');
        const contentJson = doc.contentJson as typeof base.contentJson;
        const result = await call('meeting:save', { documentId, base, contentJson });
        if (result.conflict)
          throw new Error(
            'This note changed while applying the suggestion. Your version was kept in Conflicted copies.',
          );
        autosave.rebase({ title: base.title, contentJson });
        adopt(doc.contentJson);
      };
    },
  };
}
