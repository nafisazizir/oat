'use client';

import type { TaskOwner } from '@oat/editor';
import { useCallback, useEffect, useState } from 'react';

import { ApiRequestError } from '@/lib/api-client';
import type { ApiErrorBody } from '@/lib/api-types';
import type {
  TaskAssigneesResponse,
  TaskDueFilter,
  TaskListResponse,
  TaskStatus,
  TaskView,
  UpdateTaskInput,
} from '@/lib/tasks';

/** Browser calls to `/api/tasks*` (cookie session; same-origin). Non-2xx → {@link ApiRequestError}. */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiRequestError(0, 'network', 'You’re offline or the server can’t be reached.');
  }
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const error = json as ApiErrorBody | undefined;
    throw new ApiRequestError(
      res.status,
      error?.error?.code ?? 'bad_request',
      error?.error?.message ?? `Request failed (${res.status}).`,
      error,
    );
  }
  return json as T;
}

export type TaskQuery = {
  view: TaskView;
  status: TaskStatus;
  due: TaskDueFilter;
  /** The viewer's local day. */
  today: string;
  workspaceId: string;
};

export const tasksClient = {
  list: (query: TaskQuery, signal?: AbortSignal) =>
    request<TaskListResponse>(
      'GET',
      `/api/tasks?${new URLSearchParams(query).toString()}`,
      undefined,
      signal,
    ),
  setDone: (id: string, input: UpdateTaskInput) =>
    request<{ id: string; done: boolean; documentVersion: number }>(
      'PATCH',
      `/api/tasks/${encodeURIComponent(id)}`,
      input,
    ),
  assignees: (documentId: string, q: string) =>
    request<TaskAssigneesResponse>(
      'GET',
      `/api/tasks/assignees?${new URLSearchParams({ documentId, q }).toString()}`,
    ),
};

/**
 * The owner picker's people source for one note (`OatEditor` `onTaskAssigneeQuery`): workspace members and the
 * meeting's attendees from `/api/tasks/assignees`. Stable per document; errors read as "nobody" (a typed name
 * still works).
 */
export function useTaskAssignees(documentId: string) {
  return useCallback(
    async (q: string): Promise<TaskOwner[]> => {
      try {
        return (await tasksClient.assignees(documentId, q)).people;
      } catch {
        return [];
      }
    },
    [documentId],
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
  const key = JSON.stringify([query, attempt]);
  const [result, setResult] = useState<
    { key: string; data: TaskListResponse } | { key: string; error: string } | undefined
  >();
  const [last, setLast] = useState<TaskListResponse | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    tasksClient.list(query, controller.signal).then(
      (data) => {
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
    // `key` covers every field of `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (result?.key === key) {
    return 'data' in result
      ? { status: 'done', data: result.data }
      : { status: 'error', message: result.error, data: last };
  }
  return { status: 'loading', data: last };
}
