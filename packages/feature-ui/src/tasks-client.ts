'use client';

import type { TaskOwner } from '@oat/editor';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useFeatureUi } from './provider';
import type { TaskDueFilter, TaskListResponse, TaskStatus, TaskView } from './task-helpers';

export type TaskQuery = {
  view: TaskView;
  status: TaskStatus;
  due: TaskDueFilter;
  /** The viewer's local day. */
  today: string;
  workspaceId: string;
};

/**
 * The owner picker's people source for one note (`OatEditor` `onTaskAssigneeQuery`): workspace members and the
 * meeting's attendees from `/api/tasks/assignees`. Stable per document; errors read as "nobody" (a typed name
 * still works).
 */
export function useTaskAssignees(documentId: string) {
  const { client } = useFeatureUi();
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [client, documentId]);
  return useCallback(
    async (q: string): Promise<TaskOwner[]> => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const result = await client.tasks.assignees(
          { documentId, q },
          { signal: controller.signal },
        );
        return controller.signal.aborted ? [] : result.people;
      } catch {
        return [];
      } finally {
        requests.current.delete(controller);
      }
    },
    [client, documentId],
  );
}

export type TasksState =
  | { status: 'loading'; data?: TaskListResponse }
  | { status: 'done'; data: TaskListResponse }
  | { status: 'error'; message: string; data?: TaskListResponse };

/**
 * Loads `/api/tasks` for `query`; refetches when it changes or `attempt` is bumped. While a new query loads, the
 * previous items stay (`data`), so the list doesn't flash.
 */
export function useTasks(query: TaskQuery, attempt: number): TasksState {
  const { client } = useFeatureUi();
  const { view, status, due, today, workspaceId } = query;
  const key = JSON.stringify([query, attempt]);
  const [result, setResult] = useState<
    { key: string; data: TaskListResponse } | { key: string; error: string } | undefined
  >();
  const [last, setLast] = useState<TaskListResponse | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    client.tasks
      .list({ view, status, due, today, workspaceId }, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return;
          setResult({ key, data });
          setLast(data);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({
            key,
            error: error instanceof Error ? error.message : 'Couldn’t load your tasks.',
          });
        },
      );
    return () => controller.abort();
  }, [key, client, view, status, due, today, workspaceId]);

  if (result?.key === key) {
    return 'data' in result
      ? { status: 'done', data: result.data }
      : { status: 'error', message: result.error, data: last };
  }
  return { status: 'loading', data: last };
}
