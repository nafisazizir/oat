/**
 * Action items (8.4): a document's `taskItem` blocks → `action_item` rows. Run by the index worker for every
 * `document:<id>` job (it follows `change_log`, D-22) before the embedding work, and by the task toggle API right
 * after it writes a document, so "My tasks" never waits on embeddings.
 *
 * Owners: an owner with a `userId` keeps it only when that user is a member of the document's workspace; an
 * owner with an email that belongs to a member gets that member's user id. Anything else is kept by name/email
 * only ("assigned to me" also matches by email at query time).
 */
import {
  type ActionItemDraft,
  type Db,
  document,
  MAX_ACTION_ITEM_TEXT,
  membership,
  replaceDocumentActionItems,
  type ReplaceActionItemsResult,
  user,
} from '@oat/db';
import { type JSONContent, taskMetaOf, type TaskOwner } from '@oat/editor';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

/** An extracted task before owners are matched to members. */
export interface ExtractedActionItem {
  blockId: string;
  ordinal: number;
  text: string;
  owner: TaskOwner | null;
  due: string | null;
  done: boolean;
}

/** One line of plain text from inline content (mentions as `@Name`, breaks as spaces). */
function inlineText(nodes: readonly JSONContent[] | undefined): string {
  let out = '';
  for (const node of nodes ?? []) {
    if (node.type === 'text') out += node.text ?? '';
    else if (node.type === 'mention')
      out += `@${String(node.attrs?.label ?? node.attrs?.id ?? '')}`;
    else if (node.type === 'hardBreak') out += ' ';
    else if (node.content) out += inlineText(node.content);
  }
  return out;
}

/**
 * Every task item of a document, in document order (nested ones too). The text is the item's first paragraph;
 * items without text or a block id are skipped.
 */
export function extractActionItems(doc: unknown): ExtractedActionItem[] {
  const items: ExtractedActionItem[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === 'taskItem') {
      const id = node.attrs?.id;
      const first = node.content?.[0];
      const text = inlineText(first?.type === 'paragraph' ? first.content : [])
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ACTION_ITEM_TEXT);
      if (typeof id === 'string' && id && text) {
        const { owner, due } = taskMetaOf(node.attrs);
        items.push({
          blockId: id,
          ordinal: items.length,
          text,
          owner,
          due,
          done: node.attrs?.checked === true,
        });
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (doc && typeof doc === 'object') visit(doc as JSONContent);
  return items;
}

/** Matches owners to members of `workspaceId` (by user id, else by email). */
export async function resolveOwners(
  db: Db,
  workspaceId: string,
  items: readonly ExtractedActionItem[],
): Promise<ActionItemDraft[]> {
  const ids = [...new Set(items.flatMap((i) => (i.owner?.userId ? [i.owner.userId] : [])))];
  const emails = [
    ...new Set(items.flatMap((i) => (i.owner?.email ? [i.owner.email.toLowerCase()] : []))),
  ];
  const members =
    ids.length || emails.length
      ? await db
          .select({ id: user.id, email: user.email })
          .from(membership)
          .innerJoin(user, eq(user.id, membership.userId))
          .where(
            and(
              eq(membership.workspaceId, workspaceId),
              or(
                ids.length ? inArray(user.id, ids) : undefined,
                emails.length ? inArray(sql`lower(${user.email})`, emails) : undefined,
              ),
            ),
          )
      : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  return items.map((item) => {
    const owner = item.owner;
    const member =
      (owner?.userId ? byId.get(owner.userId) : undefined) ??
      (owner?.email ? byEmail.get(owner.email.toLowerCase()) : undefined);
    return {
      blockId: item.blockId,
      ordinal: item.ordinal,
      text: item.text,
      ownerUserId: member?.id ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? member?.email ?? null,
      due: item.due,
      done: item.done,
    };
  });
}

export type SyncActionItemsResult = ReplaceActionItemsResult | { status: 'missing' };

/** Re-extracts the action items of one document (idempotent). `missing` when the document is gone. */
export async function syncActionItems(db: Db, documentId: string): Promise<SyncActionItemsResult> {
  const [doc] = await db
    .select({
      id: document.id,
      workspaceId: document.workspaceId,
      contentJson: document.contentJson,
      version: document.version,
    })
    .from(document)
    .where(eq(document.id, documentId));
  if (!doc) return { status: 'missing' };
  const drafts = await resolveOwners(db, doc.workspaceId, extractActionItems(doc.contentJson));
  try {
    return await replaceDocumentActionItems(
      db,
      { documentId: doc.id, workspaceId: doc.workspaceId, documentVersion: doc.version },
      drafts,
    );
  } catch (error) {
    // Deleted between the read and the write (FK violation): nothing to keep.
    const [still] = await db
      .select({ id: document.id })
      .from(document)
      .where(eq(document.id, documentId));
    if (!still) return { status: 'missing' };
    throw error;
  }
}
