/**
 * "My tasks" (8.4): shapes shared by `/api/tasks*` and the `/tasks` page. An item is a `taskItem` block of a
 * note, read from the derived `action_item` table; its document stays the source of truth.
 */
import type { DocumentKind } from '@oat/core';
import type { Route } from 'next';

export const TASK_VIEWS = ['assigned', 'created', 'all'] as const;
/** Assigned to me · in notes I created · everything in the workspace I can read. */
export type TaskView = (typeof TASK_VIEWS)[number];

export const TASK_STATUSES = ['open', 'done', 'all'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_DUE_FILTERS = ['any', 'overdue', 'soon'] as const;
/** `soon`: due today or within the next 7 days. */
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

export const TASK_VIEW_LABELS: Record<TaskView, string> = {
  assigned: 'Assigned to me',
  created: 'Created by me',
  all: 'All in workspace',
};

export type TaskOwnerDto = {
  name: string;
  email: string | null;
  userId: string | null;
  /** The owner is the signed-in user (by user id or email). */
  isMe: boolean;
};

export type TaskItemDto = {
  id: string;
  /** The `taskItem` block id: `/d/<documentId>?block=<blockId>`. */
  blockId: string;
  text: string;
  done: boolean;
  /** `YYYY-MM-DD`. */
  due: string | null;
  owner: TaskOwnerDto | null;
  document: {
    id: string;
    title: string;
    kind: DocumentKind;
    /** The version the toggle must send as `baseVersion`. */
    version: number;
    /** Meeting start (meeting notes) or creation time, ISO. */
    date: string;
    /** The signed-in user may tick this item (edit rights on the note). */
    canEdit: boolean;
  };
};

/** Most items one list returns (newest meetings first); `truncated` says there were more. */
export const TASK_LIST_LIMIT = 500;

export type TaskListResponse = { items: TaskItemDto[]; truncated: boolean };

/** `PATCH /api/tasks/:id`. */
export type UpdateTaskInput = { done: boolean; baseVersion: number };

/** Someone a task can be assigned to (`GET /api/tasks/assignees?documentId=…&q=…`). */
export type TaskAssigneeDto = { name: string; email?: string; userId?: string };
export type TaskAssigneesResponse = { people: TaskAssigneeDto[] };

/** Link to a task's block in its note. */
export const taskHref = (item: Pick<TaskItemDto, 'blockId' | 'document'>) =>
  `/d/${encodeURIComponent(item.document.id)}?block=${encodeURIComponent(item.blockId)}` as Route;

export type TaskGroup = { document: TaskItemDto['document']; items: TaskItemDto[] };

/** Items grouped by note, keeping the server's order (newest meetings first, items in note order). */
export function groupByDocument(items: readonly TaskItemDto[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const item of items) {
    const group = groups.get(item.document.id);
    if (group) group.items.push(item);
    else groups.set(item.document.id, { document: item.document, items: [item] });
  }
  return [...groups.values()];
}
