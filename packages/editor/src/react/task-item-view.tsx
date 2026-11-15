'use client';

import type { Editor } from '@tiptap/core';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
  useEditorState,
} from '@tiptap/react';
import { CalendarIcon, CheckIcon, UserIcon, UserPlusIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@oat/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@oat/ui/components/command';
import { Input } from '@oat/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { cn } from '@oat/ui/lib/utils';

import { OatTaskItem } from '../task-item.ts';
import { addDays, dueState, formatDue, localDay, nextMonday } from '../task-dates.ts';
import { cleanOwnerName, isIsoDate, taskMetaOf, type TaskOwner } from '../task-meta.ts';

/** People a task can be assigned to, for a query (workspace members, meeting attendees). May be async. */
export type TaskAssigneeQuery = (query: string) => TaskOwner[] | Promise<TaskOwner[]>;

/** Latest assignee source per editor (the node views are created by TipTap, the prop changes). */
const assigneeSources = new WeakMap<Editor, TaskAssigneeQuery>();

export function setTaskAssigneeSource(editor: Editor, source: TaskAssigneeQuery | undefined) {
  if (source) assigneeSources.set(editor, source);
  else assigneeSources.delete(editor);
}

const ownerKey = (owner: TaskOwner) => owner.userId ?? owner.email ?? `name:${owner.name}`;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/**
 * A task item in the editor (8.4): checkbox, the item's content, and its owner / due-date chips. In an editable
 * editor the chips open pickers (assign to a person from `onTaskAssigneeQuery`, or a typed name; pick a day);
 * empty ones show as "Assign" / "Due" buttons on hover. Read-only editors show the chips as plain labels.
 */
function TaskItemView({ node, editor, getPos }: ReactNodeViewProps) {
  const editable = useEditorState({ editor, selector: ({ editor: e }) => e.isEditable });
  const checked = node.attrs.checked === true;
  const { owner, due } = taskMetaOf(node.attrs);
  const today = localDay();
  const state = due && !checked ? dueState(due, today) : undefined;

  const position = () => {
    const pos = getPos();
    return typeof pos === 'number' ? pos : undefined;
  };
  const setChecked = (value: boolean) => {
    const pos = position();
    if (pos === undefined) return;
    editor
      .chain()
      .command(({ tr }) => {
        const current = tr.doc.nodeAt(pos);
        if (!current) return false;
        tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: value });
        return true;
      })
      .run();
  };
  const setOwner = (next: TaskOwner | null) => {
    const pos = position();
    if (pos !== undefined) editor.commands.setTaskOwner(next, pos);
  };
  const setDue = (next: string | null) => {
    const pos = position();
    if (pos !== undefined) editor.commands.setTaskDue(next, pos);
  };

  const hasMeta = owner !== null || due !== null;
  return (
    <NodeViewWrapper
      className="oat-task"
      data-checked={checked ? 'true' : 'false'}
      data-has-meta={hasMeta || undefined}
    >
      <label contentEditable={false} className="oat-task-check">
        <input
          type="checkbox"
          checked={checked}
          disabled={!editable}
          aria-label={checked ? 'Mark as not done' : 'Mark as done'}
          onMouseDown={(event) => event.preventDefault()}
          onChange={(event) => {
            if (editable) setChecked(event.target.checked);
          }}
        />
      </label>
      <NodeViewContent className="oat-task-content" />
      {(hasMeta || editable) && (
        <span contentEditable={false} className="oat-task-meta" data-testid="task-meta">
          {editable ? (
            <OwnerPicker editor={editor} owner={owner} onChange={setOwner} />
          ) : (
            owner && <OwnerChip owner={owner} />
          )}
          {editable ? (
            <DuePicker due={due} state={state} today={today} onChange={setDue} />
          ) : (
            due && <DueChip due={due} state={state} today={today} />
          )}
        </span>
      )}
    </NodeViewWrapper>
  );
}

function OwnerChip({ owner }: { owner: TaskOwner }) {
  return (
    <span className="oat-task-chip" data-kind="owner" title={owner.email ?? owner.name}>
      <span className="oat-task-avatar" aria-hidden>
        {initials(owner.name)}
      </span>
      <span className="truncate">{owner.name}</span>
    </span>
  );
}

function DueChip({ due, state, today }: { due: string; state?: string; today: string }) {
  return (
    <span className="oat-task-chip" data-kind="due" data-state={state} title={`Due ${due}`}>
      <CalendarIcon className="size-3" aria-hidden />
      {formatDue(due, today)}
    </span>
  );
}

function OwnerPicker({
  editor,
  owner,
  onChange,
}: {
  editor: Editor;
  owner: TaskOwner | null;
  onChange: (owner: TaskOwner | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Results for the query they were fetched for; anything else is still loading.
  const [result, setResult] = useState<{ query: string; people: TaskOwner[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    const source = assigneeSources.get(editor);
    if (!source) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.resolve(source(query))
        .catch(() => [] as TaskOwner[])
        .then((people) => {
          if (!cancelled) setResult({ query, people });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, editor]);

  const people = result?.people ?? [];
  const loading = result?.query !== query && assigneeSources.has(editor);
  const typed = cleanOwnerName(query);
  const exact = people.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  const choose = (next: TaskOwner | null) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {owner ? (
          <button
            type="button"
            className="oat-task-chip"
            data-kind="owner"
            aria-label={`Assigned to ${owner.name}. Change`}
            title={owner.email ?? owner.name}
          >
            <span className="oat-task-avatar" aria-hidden>
              {initials(owner.name)}
            </span>
            <span className="truncate">{owner.name}</span>
          </button>
        ) : (
          <button type="button" className="oat-task-add" aria-label="Assign task">
            <UserPlusIcon className="size-3.5" aria-hidden />
            <span>Assign</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0" data-testid="task-owner-picker">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Assign to…"
            value={query}
            onValueChange={setQuery}
            aria-label="Search people"
          />
          <CommandList>
            {!loading && people.length === 0 && !typed && (
              <CommandEmpty>Type a name to assign.</CommandEmpty>
            )}
            {people.length > 0 && (
              <CommandGroup heading="People">
                {people.map((person) => (
                  <CommandItem
                    key={ownerKey(person)}
                    value={ownerKey(person)}
                    onSelect={() => choose(person)}
                  >
                    {/* The popover is portalled outside `.oat-editor`: Tailwind, not the editor's CSS. */}
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-me text-xs font-semibold text-me-foreground"
                      aria-hidden
                    >
                      {initials(person.name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{person.name}</span>
                      {person.email && (
                        <span className="truncate text-xs text-muted-foreground">
                          {person.email}
                        </span>
                      )}
                    </span>
                    {owner && ownerKey(owner) === ownerKey(person) && (
                      <CheckIcon className="size-4" aria-hidden />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {(typed && !exact) || owner ? (
              <CommandGroup>
                {typed && !exact && (
                  <CommandItem value={`typed:${typed}`} onSelect={() => choose({ name: typed })}>
                    <UserIcon aria-hidden />
                    <span className="truncate">Assign to “{typed}”</span>
                  </CommandItem>
                )}
                {owner && (
                  <CommandItem value="unassign" onSelect={() => choose(null)}>
                    <XIcon aria-hidden />
                    Unassign
                  </CommandItem>
                )}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DuePicker({
  due,
  state,
  today,
  onChange,
}: {
  due: string | null;
  state?: string;
  today: string;
  onChange: (due: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const choose = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const quick = [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: addDays(today, 1) },
    { label: 'Next week', day: nextMonday(today) },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {due ? (
          <button
            type="button"
            className="oat-task-chip"
            data-kind="due"
            data-state={state}
            aria-label={`Due ${formatDue(due, today)}. Change`}
            title={`Due ${due}`}
          >
            <CalendarIcon className="size-3" aria-hidden />
            {formatDue(due, today)}
          </button>
        ) : (
          <button type="button" className="oat-task-add" aria-label="Set due date">
            <CalendarIcon className="size-3.5" aria-hidden />
            <span>Due</span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60" data-testid="task-due-picker">
        <div className="flex flex-wrap gap-1.5">
          {quick.map(({ label, day }) => (
            <Button
              key={label}
              type="button"
              size="xs"
              variant={due === day ? 'secondary' : 'outline'}
              onClick={() => choose(day)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Input
          type="date"
          aria-label="Due date"
          value={due ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            if (isIsoDate(value)) choose(value);
          }}
        />
        {due && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className={cn('self-start text-muted-foreground')}
            onClick={() => choose(null)}
          >
            <XIcon data-icon="inline-start" />
            Clear due date
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The editor's task item: `OatTaskItem` (same schema) rendered with {@link TaskItemView}. The outer `<li>` keeps
 * the attributes the static HTML has (`data-type`, `data-checked`, `data-id`, `data-origin`), so block links
 * (`?block=`) and styles find it.
 */
export const ReactTaskItem = OatTaskItem.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TaskItemView, {
      as: 'li',
      // Always the same keys (the renderer sets attributes but never removes one).
      attrs: ({ node }) => ({
        'data-type': 'taskItem',
        'data-id': typeof node.attrs.id === 'string' ? node.attrs.id : '',
        'data-origin': node.attrs.origin === 'ai' ? 'ai' : 'me',
        'data-checked': node.attrs.checked === true ? 'true' : 'false',
      }),
    });
  },
});
