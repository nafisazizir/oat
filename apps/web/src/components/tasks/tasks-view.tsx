'use client';

import { dueState, formatDue, localDay } from '@oat/editor/task-dates';
import { Alert, AlertAction, AlertDescription } from '@oat/ui/components/alert';
import { Badge } from '@oat/ui/components/badge';
import { Button } from '@oat/ui/components/button';
import { Checkbox } from '@oat/ui/components/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@oat/ui/components/empty';
import { Item, ItemActions, ItemContent } from '@oat/ui/components/item';
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
  IconAlertCircle,
  IconCalendar,
  IconChecklist,
  IconCircleCheck,
  IconFileText,
  IconNotes,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { setDoneRetryingOnce, toggleFailure } from './task-toggle';

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
      const result = await setDoneRetryingOnce(tasksClient.setDone, item.id, done, version);
      patch((o) => {
        o.done.set(item.id, done);
        o.versions.set(item.document.id, result.documentVersion);
      });
    } catch (error) {
      patch((o) => o.done.delete(item.id));
      const failure = toggleFailure(error);
      toast.error('Couldn’t update the task', { description: failure.description });
      if (failure.reload) setAttempt((n) => n + 1);
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
          <Alert variant="destructive" role="alert">
            <IconAlertCircle />
            <AlertDescription>{state.message}</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : state.status === 'loading' && !state.data ? (
          <TasksSkeleton />
        ) : groups.length === 0 ? (
          <Empty className="border border-gray-alpha-400" data-testid="tasks-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {status === 'done' ? <IconCircleCheck /> : <IconChecklist />}
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={2}>
                {status === 'done'
                  ? 'Nothing done yet'
                  : due !== 'any'
                    ? `Nothing ${due === 'overdue' ? 'overdue' : 'due this week'}`
                    : EMPTY[view].title}
              </EmptyTitle>
              <EmptyDescription>
                {due !== 'any' || status === 'done'
                  ? 'Try another filter to see more.'
                  : EMPTY[view].description}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className={cn(
              'flex flex-col gap-8 transition-opacity duration-150',
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
                <GroupHeader>
                  {group.document.kind === 'meeting' ? (
                    <IconNotes aria-hidden className="size-4 shrink-0 text-gray-900" />
                  ) : (
                    <IconFileText aria-hidden className="size-4 shrink-0 text-gray-900" />
                  )}
                  <Link
                    href={`/d/${group.document.id}`}
                    className="min-w-0 truncate text-heading-14 text-gray-1000 underline-offset-4 hover:underline"
                  >
                    {group.document.title || 'Untitled'}
                  </Link>
                  <span className="shrink-0 text-copy-13 text-gray-900 tabular-nums">
                    {formatDay(group.document.date)}
                  </span>
                </GroupHeader>
                <ul className={listClass}>
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
              <p className="text-copy-13 text-gray-900" role="status" data-testid="tasks-truncated">
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

const listClass =
  'flex flex-col divide-y divide-gray-alpha-400 overflow-hidden rounded-xl border border-gray-alpha-400';
const rowClass = 'items-start rounded-none border-0';

function GroupHeader({ children }: { children: React.ReactNode }) {
  return <header className="flex h-5 items-center gap-2 ps-3">{children}</header>;
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
    <Item
      size="sm"
      render={<li />}
      className={rowClass}
      data-testid="task-row"
      data-done={done || undefined}
    >
      <Checkbox
        checked={done}
        disabled={!item.document.canEdit || busy}
        onCheckedChange={(checked) => onToggle(checked)}
        aria-label={done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
        title={item.document.canEdit ? undefined : 'You can view this note but not edit it'}
        className="mt-0.5"
      />
      <ItemContent className="min-w-0">
        <Link
          href={taskHref(item)}
          className={cn(
            'text-copy-14 text-gray-1000 underline-offset-4 hover:underline',
            done && 'text-gray-900 line-through decoration-gray-700',
          )}
        >
          {item.text}
        </Link>
      </ItemContent>
      {(item.owner || item.due) && (
        <ItemActions className="h-5 gap-1.5">
          {item.owner && (
            <Badge
              variant="secondary"
              className="max-w-40 ps-0.5"
              title={item.owner.email ?? item.owner.name}
              data-testid="task-owner"
            >
              <span
                aria-hidden
                className="flex size-4 items-center justify-center rounded-full bg-me text-[0.625rem] leading-none text-me-foreground"
              >
                {initials(item.owner.name)}
              </span>
              <span className="truncate">{item.owner.isMe ? 'You' : item.owner.name}</span>
            </Badge>
          )}
          {item.due && (
            <Badge
              variant={state === 'overdue' ? 'destructive' : 'secondary'}
              className={cn(state === 'today' && 'bg-amber-200 text-amber-1000')}
              title={`Due ${item.due}`}
              data-testid="task-due"
              data-state={state}
            >
              <IconCalendar data-icon="inline-start" aria-hidden />
              {formatDue(item.due, today)}
            </Badge>
          )}
        </ItemActions>
      )}
    </Item>
  );
}

/** One note group with three rows: the same boxes the list lands in. */
function TasksSkeleton() {
  return (
    <div className="flex flex-col gap-8" role="status" aria-busy="true" aria-label="Loading tasks">
      {[3, 2].map((rows, group) => (
        <section key={group} className="flex flex-col gap-2">
          <GroupHeader>
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3.5 w-48" />
          </GroupHeader>
          <ul className={listClass}>
            {Array.from({ length: rows }, (_, row) => (
              <Item key={row} size="sm" render={<li />} className={rowClass}>
                <Skeleton className="mt-0.5 size-4 rounded-sm" />
                <ItemContent>
                  <div className="flex h-5 items-center">
                    <Skeleton className={cn('h-3.5', row % 2 ? 'w-1/2' : 'w-3/4')} />
                  </div>
                </ItemContent>
                <ItemActions className="h-5">
                  <Skeleton className="h-5 w-16 rounded-full" />
                </ItemActions>
              </Item>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The page's Suspense fallback: the toolbar's footprint, then the list skeleton. */
export function TasksViewSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-9 w-72 rounded-lg" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-36 rounded-md" />
        </div>
      </div>
      <TasksSkeleton />
    </div>
  );
}
