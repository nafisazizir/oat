'use client';

import { dueState, formatDue, localDay } from '@oat/editor/task-dates';
import { Button } from '@oat/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@oat/ui/components/select';
import { Skeleton } from '@oat/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@oat/ui/components/tabs';
import { cn } from '@oat/ui/lib/utils';
import {
  AlertCircleIcon,
  CalendarIcon,
  CircleCheckBigIcon,
  FileTextIcon,
  ListTodoIcon,
  NotebookPenIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/page';
import { isApiError } from '@/lib/api-client';
import { formatDay } from '@/lib/format';
import {
  groupByDocument,
  TASK_DUE_FILTERS,
  TASK_LIST_LIMIT,
  TASK_STATUSES,
  TASK_VIEW_LABELS,
  TASK_VIEWS,
  type TaskDueFilter,
  type TaskItemDto,
  type TaskStatus,
  type TaskView,
  taskHref,
} from '@/lib/tasks';

import { tasksClient, useTasks } from './tasks-client';

const STATUS_LABELS: Record<TaskStatus, string> = { open: 'Open', done: 'Done', all: 'All' };
const DUE_LABELS: Record<TaskDueFilter, string> = {
  any: 'Any due date',
  overdue: 'Overdue',
  soon: 'Due this week',
};

const pick = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

const EMPTY: Record<TaskView, { title: string; description: string }> = {
  assigned: {
    title: 'Nothing assigned to you',
    description:
      'Action items from meeting notes land here when they’re assigned to you. Enhance a meeting, or assign a task in any note.',
  },
  created: {
    title: 'No action items in your notes',
    description:
      'Add a to-do list to a note (type [] or /to-do), or enhance a meeting to pull out its next steps.',
  },
  all: {
    title: 'No action items yet',
    description: 'To-dos from every note you can see in this workspace show up here.',
  },
};

/**
 * `/tasks`: action items across meetings (8.4). Tabs pick whose items (assigned to me / created by me / all),
 * selects filter by status and due date; items are grouped by note, newest meetings first. Ticking an item writes
 * its note (with the version it was loaded at; a note changed meanwhile is re-read and the tick retried once).
 * Filters live in the URL (`?view=&status=&due=`), updated in place.
 */
export function TasksView({ workspaceId }: { workspaceId: string }) {
  const params = useSearchParams();
  const [view, setView] = useState<TaskView>(() =>
    pick(TASK_VIEWS, params.get('view'), 'assigned'),
  );
  const [status, setStatus] = useState<TaskStatus>(() =>
    pick(TASK_STATUSES, params.get('status'), 'open'),
  );
  const [due, setDue] = useState<TaskDueFilter>(() =>
    pick(TASK_DUE_FILTERS, params.get('due'), 'any'),
  );
  const [today] = useState(() => localDay());
  const [attempt, setAttempt] = useState(0);
  const state = useTasks({ view, status, due, today, workspaceId }, attempt);

  // Optimistic ticks and versions written since the list loaded (cleared when it reloads).
  const [overrides, setOverrides] = useState<{
    key: unknown;
    done: Map<string, boolean>;
    versions: Map<string, number>;
  }>({ key: state.data, done: new Map(), versions: new Map() });
  const current =
    overrides.key === state.data
      ? overrides
      : { key: state.data, done: new Map(), versions: new Map() };
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const syncUrl = (next: { view?: TaskView; status?: TaskStatus; due?: TaskDueFilter }) => {
    const url = new URL(window.location.href);
    const merged = { view, status, due, ...next };
    url.searchParams.set('view', merged.view);
    url.searchParams.set('status', merged.status);
    url.searchParams.set('due', merged.due);
    window.history.replaceState(window.history.state, '', url);
  };

  const patch = (fn: (o: typeof current) => void) => {
    const next = {
      key: current.key,
      done: new Map(current.done),
      versions: new Map(current.versions),
    };
    fn(next);
    setOverrides(next);
  };

  async function toggle(item: TaskItemDto, done: boolean) {
    const version = current.versions.get(item.document.id) ?? item.document.version;
    patch((o) => o.done.set(item.id, done));
    setPending((p) => new Set(p).add(item.id));
    try {
      let result;
      try {
        result = await tasksClient.setDone(item.id, { done, baseVersion: version });
      } catch (error) {
        // The note changed since the list loaded: retry once on the server's version.
        const fresh = isApiError(error, 'stale_version')
          ? error.body?.document?.version
          : undefined;
        if (fresh === undefined) throw error;
        result = await tasksClient.setDone(item.id, { done, baseVersion: fresh });
      }
      patch((o) => {
        o.done.set(item.id, done);
        o.versions.set(item.document.id, result.documentVersion);
      });
    } catch (error) {
      patch((o) => o.done.delete(item.id));
      const message =
        isApiError(error, 'stale_version') || isApiError(error, 'not_found')
          ? 'That note changed. The list is up to date now — try again.'
          : error instanceof Error
            ? error.message
            : 'Couldn’t update the task.';
      toast.error('Couldn’t update the task', { description: message });
      if (isApiError(error, 'stale_version') || isApiError(error, 'not_found')) {
        setAttempt((n) => n + 1);
      }
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(item.id);
        return next;
      });
    }
  }

  const items = state.data?.items ?? [];
  const groups = groupByDocument(items);

  // The view switcher is a real tab list: the task list below is its panel.
  return (
    <Tabs
      value={view}
      onValueChange={(value) => {
        const next = value as TaskView;
        setView(next);
        syncUrl({ view: next });
      }}
      className="gap-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList aria-label="Whose tasks">
          {TASK_VIEWS.map((v) => (
            <TabsTrigger key={v} value={v} data-testid={`tasks-view-${v}`}>
              {TASK_VIEW_LABELS[v]}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex items-center gap-2">
          <Select
            items={TASK_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] }))}
            value={status}
            onValueChange={(value) => {
              setStatus(value as TaskStatus);
              syncUrl({ status: value as TaskStatus });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Status"
              data-testid="tasks-status"
              className="min-w-24"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {TASK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={TASK_DUE_FILTERS.map((value) => ({ value, label: DUE_LABELS[value] }))}
            value={due}
            onValueChange={(value) => {
              setDue(value as TaskDueFilter);
              syncUrl({ due: value as TaskDueFilter });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Due date"
              data-testid="tasks-due"
              className="min-w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {TASK_DUE_FILTERS.map((d) => (
                <SelectItem key={d} value={d}>
                  {DUE_LABELS[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <TabsContent value={view} className="flex flex-col gap-6">
        {state.status === 'error' && !state.data ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
          >
            <AlertCircleIcon className="size-4 text-destructive" />
            <span className="flex-1">{state.message}</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : state.status === 'loading' && !state.data ? (
          <TasksSkeleton />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={status === 'done' ? CircleCheckBigIcon : ListTodoIcon}
            title={
              status === 'done'
                ? 'Nothing done yet'
                : due !== 'any'
                  ? `Nothing ${due === 'overdue' ? 'overdue' : 'due this week'}`
                  : EMPTY[view].title
            }
            description={
              due !== 'any' || status === 'done'
                ? 'Try another filter to see more.'
                : EMPTY[view].description
            }
          />
        ) : (
          <div
            className={cn(
              'flex flex-col gap-8 transition-opacity duration-fast',
              state.status === 'loading' && 'opacity-60',
            )}
            aria-busy={state.status === 'loading'}
            data-testid="tasks-list"
          >
            {groups.map((group) => (
              <section
                key={group.document.id}
                className="flex flex-col gap-2"
                data-testid="task-group"
              >
                <header className="flex items-baseline gap-2 px-1">
                  {group.document.kind === 'meeting' ? (
                    <NotebookPenIcon className="size-4 shrink-0 translate-y-0.5 text-muted-foreground" />
                  ) : (
                    <FileTextIcon className="size-4 shrink-0 translate-y-0.5 text-muted-foreground" />
                  )}
                  <Link
                    href={`/d/${group.document.id}`}
                    className="min-w-0 truncate font-medium hover:underline hover:underline-offset-4"
                  >
                    {group.document.title || 'Untitled'}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDay(group.document.date)}
                  </span>
                </header>
                <ul className="divide-y rounded-xl border bg-card">
                  {group.items.map((item) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      done={current.done.get(item.id) ?? item.done}
                      busy={pending.has(item.id)}
                      today={today}
                      onToggle={(done) => void toggle(item, done)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {state.data?.truncated && (
              <p
                className="text-sm text-muted-foreground"
                role="status"
                data-testid="tasks-truncated"
              >
                Showing the first {TASK_LIST_LIMIT} tasks, newest meetings first. Narrow the filters
                to see the rest.
              </p>
            )}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function TaskRow({
  item,
  done,
  busy,
  today,
  onToggle,
}: {
  item: TaskItemDto;
  done: boolean;
  busy: boolean;
  today: string;
  onToggle: (done: boolean) => void;
}) {
  const state = item.due && !done ? dueState(item.due, today) : undefined;
  return (
    <li
      className="flex items-start gap-3 px-4 py-3"
      data-testid="task-row"
      data-done={done || undefined}
    >
      <input
        type="checkbox"
        checked={done}
        disabled={!item.document.canEdit || busy}
        onChange={(event) => onToggle(event.target.checked)}
        aria-label={done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
        title={item.document.canEdit ? undefined : 'You can view this note but not edit it'}
        className="mt-1 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
      <Link
        href={taskHref(item)}
        className={cn(
          'min-w-0 flex-1 text-sm leading-6 hover:underline hover:underline-offset-4',
          done && 'text-muted-foreground line-through decoration-muted-foreground/60',
        )}
      >
        {item.text}
      </Link>
      <div className="flex shrink-0 items-center gap-1.5 text-xs leading-6">
        {item.owner && (
          <span
            className="inline-flex h-6 max-w-40 items-center gap-1.5 rounded-full bg-muted pr-2 pl-1 text-muted-foreground"
            title={item.owner.email ?? item.owner.name}
            data-testid="task-owner"
          >
            <span
              aria-hidden
              className="flex size-4 items-center justify-center rounded-full bg-me text-[0.625rem] font-semibold text-me-foreground"
            >
              {initials(item.owner.name)}
            </span>
            <span className="truncate">{item.owner.isMe ? 'You' : item.owner.name}</span>
          </span>
        )}
        {item.due && (
          <span
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full px-2',
              state === 'overdue'
                ? 'bg-destructive/12 text-destructive'
                : state === 'today'
                  ? 'bg-warning/25 text-warning-foreground'
                  : 'bg-muted text-muted-foreground',
            )}
            title={`Due ${item.due}`}
            data-testid="task-due"
            data-state={state}
          >
            <CalendarIcon className="size-3" aria-hidden />
            {formatDue(item.due, today)}
          </span>
        )}
      </div>
    </li>
  );
}

function TasksSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading tasks">
      <Skeleton className="h-5 w-48" />
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}
