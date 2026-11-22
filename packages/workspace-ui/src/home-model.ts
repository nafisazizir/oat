import type { DocumentNode } from './tree';

export type HomeDocument = {
  id: string;
  title: string;
  kind: 'meeting' | 'page';
  updatedAt: string;
  meetingId?: string | null;
  pending?: boolean;
};
export function homeDocuments(
  server: readonly DocumentNode[],
  local: readonly HomeDocument[] = [],
  {
    trash = [],
    includeCached = false,
  }: { trash?: readonly { id: string }[]; includeCached?: boolean } = {},
): HomeDocument[] {
  const deleted = new Set(trash.map((doc) => doc.id));
  const result = new Map<string, HomeDocument>();
  for (const doc of server) {
    if (doc.kind !== 'folder' && !doc.deletedAt && !deleted.has(doc.id))
      result.set(doc.id, {
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        updatedAt: doc.updatedAt,
      });
  }
  for (const doc of local) {
    if (deleted.has(doc.id)) continue;
    const remote = result.get(doc.id);
    if (remote)
      result.set(doc.id, {
        ...remote,
        meetingId: doc.meetingId,
        ...(doc.pending
          ? {
              title: doc.title,
              updatedAt:
                Date.parse(doc.updatedAt) > Date.parse(remote.updatedAt)
                  ? doc.updatedAt
                  : remote.updatedAt,
              pending: true,
            }
          : {}),
      });
    else if (doc.pending || includeCached) result.set(doc.id, doc);
  }
  return [...result.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
  );
}
