import type { DocumentNode, ShellData } from './tree';
import { subtreeIds } from './tree';

/**
 * A sidebar mutation shown before the server confirms it. The shell applies every pending op on top of
 * the server-rendered tree; a failed request drops its op (rollback), a confirmed one is dropped once
 * the refreshed tree arrives, so the row never flickers back to its old state in between.
 */
export type TreeOp =
  | { type: 'create'; node: DocumentNode }
  | { type: 'rename'; id: string; title: string }
  | { type: 'move'; id: string; parentId: string | null; visibility?: DocumentNode['visibility'] }
  | { type: 'trash'; id: string; deletedAt: string }
  | { type: 'deleteFolder'; id: string; deletedAt: string }
  | { type: 'restore'; id: string }
  | { type: 'deleteForever'; id: string };

/** Id prefix of rows created optimistically, before the server has assigned the real id. */
export const PENDING_ID_PREFIX = 'pending:';

export const isPendingId = (id: string) => id.startsWith(PENDING_ID_PREFIX);

function applyOp(data: TreeData, op: TreeOp): TreeData {
  const { documents, trash } = data;
  switch (op.type) {
    case 'create':
      if (documents.some((d) => d.id === op.node.id)) return data;
      return { documents: [...documents, op.node], trash };
    case 'rename':
      return {
        documents: documents.map((d) => (d.id === op.id ? { ...d, title: op.title } : d)),
        trash,
      };
    case 'move':
      return {
        documents: documents.map((d) =>
          d.id === op.id
            ? {
                ...d,
                parentId: op.parentId,
                ...(op.visibility ? { visibility: op.visibility } : {}),
              }
            : d,
        ),
        trash,
      };
    case 'trash': {
      const node = documents.find((d) => d.id === op.id);
      if (!node) return data;
      return {
        documents: documents.filter((d) => d.id !== op.id),
        trash: [{ ...node, deletedAt: op.deletedAt }, ...trash],
      };
    }
    case 'deleteFolder': {
      // The folder and its subfolders go; the pages inside land in the trash.
      const ids = subtreeIds(documents, op.id);
      const removed = documents.filter((d) => ids.has(d.id));
      return {
        documents: documents.filter((d) => !ids.has(d.id)),
        trash: [
          ...removed
            .filter((d) => d.kind !== 'folder')
            .map((d) => ({ ...d, deletedAt: op.deletedAt })),
          ...trash,
        ],
      };
    }
    case 'restore': {
      const node = trash.find((d) => d.id === op.id);
      if (!node) return data;
      // Back in its folder if that still exists, else at the top level.
      const parentId =
        node.parentId && documents.some((d) => d.id === node.parentId) ? node.parentId : null;
      return {
        documents: documents.some((d) => d.id === op.id)
          ? documents
          : [...documents, { ...node, parentId, deletedAt: null }],
        trash: trash.filter((d) => d.id !== op.id),
      };
    }
    case 'deleteForever':
      return { documents, trash: trash.filter((d) => d.id !== op.id) };
  }
}

type TreeData = Pick<ShellData, 'documents' | 'trash'>;

/** The tree as the user should see it: the server's, with every pending op applied in order. */
export function applyTreeOps<T extends TreeData>(data: T, ops: readonly TreeOp[]): T {
  if (ops.length === 0) return data;
  const next = ops.reduce<TreeData>(applyOp, { documents: data.documents, trash: data.trash });
  return { ...data, documents: next.documents, trash: next.trash };
}
