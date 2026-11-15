import { mergeTaskPeople, type TaskPerson } from '@oat/ai';
import { assertCan, canEditDocument, canReadDocument } from '@oat/core';
import {
  type ActionItemDueFilter,
  type Db,
  document,
  getActionItem,
  listActionItems,
  meeting,
  membership,
  participant,
  user,
} from '@oat/db';
import type { JSONContent } from '@oat/editor';
import { syncActionItems } from '@oat/indexing';
import { asc, eq } from 'drizzle-orm';

import {
  TASK_LIST_LIMIT,
  type TaskAssigneeDto,
  type TaskItemDto,
  type TaskListResponse,
  type TaskStatus,
  type TaskView,
  type UpdateTaskInput,
} from './dto/tasks.ts';

import type { Actor } from './actor.ts';
import { ApiError, notFound } from './errors.ts';
import { updateDocument } from './documents.ts';
import { requireMember } from './folders.ts';

/*
 * "My tasks" (8.4). Items come from `action_item` (derived from documents by the index worker, D-22), filtered
 * by permission in SQL and re-checked per row with `canReadDocument`. Ticking an item writes its document
 * (the body is canonical, D-4) through `updateDocument` — same validation, version bump and 409 as any edit —
 * then re-extracts that document's items right away so the list doesn't wait for the worker.
 */

export type ListTasksInput = {
  /** Only this workspace (must be a member); default: every workspace the user belongs to. */
  workspaceId?: string;
  view: TaskView;
  status: TaskStatus;
  due: ActionItemDueFilter;
  /** The user's local day (`YYYY-MM-DD`) for the due filters and "overdue". */
  today: string;
};

async function emailOf(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return row?.email ?? null;
}

export async function listTasks(
  db: Db,
  actor: Actor,
  input: ListTasksInput,
): Promise<TaskListResponse> {
  if (input.workspaceId) requireMember(actor, input.workspaceId);
  const workspaceIds = input.workspaceId ? [input.workspaceId] : [...actor.ctx.memberships.keys()];
  const email = await emailOf(db, actor.userId);
  const rows = await listActionItems(db, {
    limit: TASK_LIST_LIMIT + 1,
    userId: actor.userId,
    emails: email ? [email] : [],
    workspaceIds,
    scope: input.view,
    status: input.status,
    due: input.due,
    today: input.today,
  });
  const mine = (ownerUserId: string | null, ownerEmail: string | null) =>
    ownerUserId === actor.userId ||
    (!ownerUserId && !!email && ownerEmail?.toLowerCase() === email.toLowerCase());
  const truncated = rows.length > TASK_LIST_LIMIT;
  const items: TaskItemDto[] = rows
    .slice(0, TASK_LIST_LIMIT)
    .filter((row) => canReadDocument(actor.ctx, row.document))
    .map((row) => ({
      id: row.id,
      blockId: row.blockId,
      text: row.text,
      done: row.done,
      due: row.due,
      owner:
        row.ownerName || row.ownerEmail || row.ownerUserId
          ? {
              name: row.ownerName ?? row.ownerEmail ?? 'Someone',
              email: row.ownerEmail,
              userId: row.ownerUserId,
              isMe: mine(row.ownerUserId, row.ownerEmail),
            }
          : null,
      document: {
        id: row.document.id,
        title: row.document.title,
        kind: row.document.kind,
        version: row.document.version,
        date: (row.document.meetingStartedAt ?? row.document.createdAt).toISOString(),
        canEdit: canEditDocument(actor.ctx, row.document),
      },
    }));
  return { items, truncated };
}

/** Sets `checked` on the task item with `blockId`; `undefined` when the document has no such item. */
function withChecked(doc: JSONContent, blockId: string, done: boolean): JSONContent | undefined {
  let found = false;
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === 'taskItem' && node.attrs?.id === blockId) {
      found = true;
      return { ...node, attrs: { ...node.attrs, checked: done } };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  const next = visit(doc);
  return found ? next : undefined;
}

/**
 * `PATCH /api/tasks/:id`: ticks or unticks the item in its note at `baseVersion` (409 `stale_version` with the
 * server copy when the note changed since). Unreadable items are 404, read-only ones 403.
 */
export async function setTaskDone(
  db: Db,
  actor: Actor,
  id: string,
  input: UpdateTaskInput,
): Promise<{ id: string; done: boolean; documentVersion: number }> {
  const item = await getActionItem(db, id);
  if (!item) throw notFound('Task');
  const [row] = await db.select().from(document).where(eq(document.id, item.documentId));
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound('Task');
  assertCan('editDocument', actor.ctx, row);

  const content = withChecked(row.contentJson as JSONContent, item.blockId, input.done);
  if (!content) {
    // The note changed and the worker hasn't caught up: refresh this note's items and say so.
    await syncActionItems(db, row.id);
    throw new ApiError(404, 'not_found', 'This task is no longer in its note.');
  }
  // Same path as any edit: permission, validation, version check (409 + server copy), version bump.
  const updated = await updateDocument(db, actor, row.id, {
    baseVersion: input.baseVersion,
    contentJson: content,
  });
  // The note is saved: a failed write-through must not report the tick as failed (the worker catches up).
  await syncActionItems(db, row.id).catch((error: unknown) => {
    console.error(`tasks: re-extracting ${row.id} after a toggle failed`, error);
  });
  return { id: item.id, done: input.done, documentVersion: updated.version };
}

/**
 * People a task in this note can be assigned to: the members of its workspace and the meeting's participants
 * (the signed-in user first), filtered by `query` (name or email contains it).
 */
export async function listAssignees(
  db: Db,
  actor: Actor,
  documentId: string,
  query: string,
): Promise<{ people: TaskAssigneeDto[] }> {
  const [row] = await db.select().from(document).where(eq(document.id, documentId));
  if (!row || !canReadDocument(actor.ctx, row)) throw notFound();
  const [members, attendees] = await Promise.all([
    workspaceMembers(db, row.workspaceId),
    db
      .select({ name: participant.name, email: participant.email })
      .from(participant)
      .innerJoin(meeting, eq(meeting.id, participant.meetingId))
      .where(eq(meeting.documentId, row.id))
      .orderBy(asc(participant.createdAt)),
  ]);
  const me = members.filter((m) => m.userId === actor.userId);
  const others = members.filter((m) => m.userId !== actor.userId);
  const q = query.trim().toLowerCase();
  const people = mergeTaskPeople(me, others, attendees)
    .filter(
      (p) => !q || p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q),
    )
    .slice(0, 20)
    .map((p) => ({
      name: p.name,
      ...(p.email ? { email: p.email } : {}),
      ...(p.userId ? { userId: p.userId } : {}),
    }));
  return { people };
}

/** Members of a workspace as task people (name falls back to the email's local part). */
export async function workspaceMembers(db: Db, workspaceId: string): Promise<TaskPerson[]> {
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.workspaceId, workspaceId))
    .orderBy(asc(user.name));
  return rows.map((r) => ({
    name: r.name?.trim() || r.email.split('@')[0]!,
    email: r.email,
    userId: r.id,
  }));
}
