'use client';

/**
 * Who was in the meeting: "N people" in the header (`ParticipantSummary`), one row per person in its menu: from
 * the calendar event's attendees (7.3) or added by hand. Editors add (name + optional email, inline) and remove
 * them; the caller persists (web API / desktop local store).
 */
import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import {
  IconCalendar,
  IconPlus,
  IconUser,
  IconUserPlus,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import { type FormEvent, useId, useState } from 'react';

import { attendeesLabel, initials, isPlausibleEmail, type Participant } from './format.ts';
import { metaActionClass } from './meeting-meta.tsx';

export interface ParticipantChipsProps {
  participants: readonly Participant[];
  editable: boolean;
  /** Rejects with a user-facing message (shown in the form). */
  onAdd?: (input: { name: string; email: string | null }) => Promise<void>;
  onRemove?: (participant: Participant) => Promise<void>;
  className?: string;
}

export const MAX_PARTICIPANT_NAME = 200;

export function ParticipantSummary(props: ParticipantChipsProps) {
  const { participants, editable } = props;
  const count = participants.length;
  // Only me: nothing to show. Editors can still add people (revealed on hover, always on touch screens).
  if (count === 0 && !(editable && props.onAdd)) return null;
  const only = participants[0];
  return (
    <Popover
      onOpenChange={(open, details) => {
        // Escape in the add form closes the form, not the menu.
        const target = details.event?.target;
        if (!open && details.reason === 'escape-key' && target instanceof Element)
          if (target.closest('[data-participant-form]')) details.cancel();
      }}
    >
      <PopoverTrigger
        className={cn(
          metaActionClass,
          count === 0 &&
            'pointer-fine:opacity-0 pointer-fine:group-hover/meta:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100',
        )}
        aria-label={count === 0 ? 'Add attendees' : `Attendees: ${attendeesLabel(participants)}`}
        data-testid="attendees-toggle"
        data-count={count}
      >
        {count === 0 ? (
          <>
            <IconUserPlus aria-hidden />
            Add attendees
          </>
        ) : count === 1 && only ? (
          <>
            <IconUser aria-hidden />
            {only.name || only.email}
          </>
        ) : (
          <>
            <IconUsers aria-hidden />
            {count} people
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Attendees"
        className="w-72 gap-0 p-1"
        data-testid="participant-details"
      >
        <ParticipantChips {...props} />
      </PopoverContent>
    </Popover>
  );
}

/** One row per person (avatar, name, email), remove on hover; "Add attendee" at the bottom. */
export function ParticipantChips({
  participants,
  editable,
  onAdd,
  onRemove,
  className,
}: ParticipantChipsProps) {
  // Optimistic remove: the row goes at once; it comes back (with the error) if `onRemove` rejects.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  async function remove(p: Participant) {
    if (!onRemove) return;
    setRemoved((prev) => new Set(prev).add(p.id));
    setError(null);
    try {
      await onRemove(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t remove them.');
    } finally {
      setRemoved((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    }
  }

  const shown = removed.size ? participants.filter((p) => !removed.has(p.id)) : participants;

  return (
    <div className={cn('flex flex-col', className)}>
      <ul
        aria-label="Attendees"
        className="flex max-h-72 flex-col overflow-y-auto"
        data-testid="participants"
        data-count={shown.length}
      >
        {shown.map((p) => (
          <li
            key={p.id}
            data-testid="participant-chip"
            data-source={p.source}
            className="group/row flex min-h-9 items-center gap-2.5 rounded-md ps-2 pe-1 text-label-13 text-gray-1000 hover:bg-gray-alpha-100"
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-label-12 text-gray-1000"
            >
              {initials(p.name || p.email || '?')}
            </span>
            <span className="flex min-w-0 flex-1 flex-col py-1">
              <span className="truncate">{p.name || p.email}</span>
              {p.email && p.name && p.email !== p.name && (
                <span className="truncate text-label-12 text-gray-900">{p.email}</span>
              )}
            </span>
            {p.source === 'calendar' && (
              <IconCalendar
                aria-label="From the calendar"
                className="size-3.5 shrink-0 text-gray-900"
              />
            )}
            {editable && onRemove && (
              <button
                type="button"
                aria-label={`Remove ${p.name || p.email}`}
                onClick={() => void remove(p)}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-900 transition-colors hover:bg-gray-alpha-200 hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:focus-visible:opacity-100"
              >
                <IconX className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {shown.length === 0 && !(editable && onAdd) && (
          <li className="px-2 py-2 text-label-13 text-gray-900">No attendees</li>
        )}
      </ul>
      {error && (
        <p role="alert" className="px-2 py-1.5 text-label-13 text-red-900">
          {error}
        </p>
      )}
      {editable && onAdd && (
        <>
          {shown.length > 0 && <div aria-hidden className="-mx-1 my-1 h-px bg-gray-alpha-200" />}
          <AddParticipant onAdd={onAdd} />
        </>
      )}
    </div>
  );
}

function AddParticipant({ onAdd }: { onAdd: NonNullable<ParticipantChipsProps['onAdd']> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const reset = () => {
    setName('');
    setEmail('');
    setError(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const n = name.trim();
    const e = email.trim();
    if (!n && !e) return setError('Add a name or an email.');
    if (e && !isPlausibleEmail(e)) return setError('That email doesn’t look right.');
    setPending(true);
    setError(null);
    try {
      await onAdd({ name: (n || e).slice(0, MAX_PARTICIPANT_NAME), email: e || null });
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t add them.');
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-9 items-center gap-2.5 rounded-md px-2 text-label-13 text-gray-900 outline-none hover:bg-gray-alpha-100 hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50"
        data-testid="add-participant"
      >
        <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
          <IconPlus className="size-4" />
        </span>
        Add attendee
      </button>
    );

  return (
    <form
      data-participant-form
      noValidate
      className="flex flex-col gap-2.5 p-2"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        reset();
        setOpen(false);
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={name}
          autoFocus
          maxLength={MAX_PARTICIPANT_NAME}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-email`}>
          Email <span className="text-gray-900">(optional)</span>
        </Label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          maxLength={320}
          autoComplete="off"
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-label-13 text-red-900">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Add
        </Button>
      </div>
    </form>
  );
}
