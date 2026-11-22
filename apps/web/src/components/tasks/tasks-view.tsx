'use client';

import {
  TasksView as SharedTasksView,
  TASK_VIEWS,
  TASK_STATUSES,
  TASK_DUE_FILTERS,
  type TaskFilters,
} from '@oat/feature-ui/tasks';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

const pick = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

export function TasksView() {
  const params = useSearchParams();
  const [value, setValue] = useState<TaskFilters>(() => ({
    view: pick(TASK_VIEWS, params.get('view'), 'assigned'),
    status: pick(TASK_STATUSES, params.get('status'), 'open'),
    due: pick(TASK_DUE_FILTERS, params.get('due'), 'any'),
  }));
  function onChange(next: TaskFilters) {
    setValue(next);
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(next)) url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, '', url);
  }
  return <SharedTasksView value={value} onChange={onChange} />;
}
