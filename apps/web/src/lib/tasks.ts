/**
 * "My tasks" (8.4): the API shapes live in `@oat/services` (shared with the server code there, 8.3); the
 * page-only helpers (typed links, grouping) live here.
 */
import type { TaskItemDto } from '@oat/services/dto/tasks';
import type { Route } from 'next';

export * from '@oat/services/dto/tasks';

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
