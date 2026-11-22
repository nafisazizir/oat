import type { DocumentDetail } from '@oat/services/dto/api-types';

export const DOCUMENT_CHANGED_EVENT = 'oat:document-changed';
export type DocumentChangedDetail = Pick<DocumentDetail, 'id' | 'version' | 'title'>;

export function announceDocumentChange(doc: DocumentChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<DocumentChangedDetail>(DOCUMENT_CHANGED_EVENT, {
      detail: { id: doc.id, version: doc.version, title: doc.title },
    }),
  );
}
