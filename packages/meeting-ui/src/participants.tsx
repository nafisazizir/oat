'use client';

/**
 * Who was in the meeting: "N people" in the header, a small row menu behind it with one row per person
 * (from the calendar event's attendees, 7.3, or added by hand). Editors remove someone from their row's
 * submenu and add people from "Add attendee"; the caller persists (web API / desktop local store).
 */
import { Button } from '@oat/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent } from '@oat/ui/components/popover';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import { IconPlus, IconTrash, IconUser, IconUserPlus, IconUsers } from '@tabler/icons-react';
import { type FormEvent, useId, useRef, useState } from 'react';

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

export function ParticipantSummary({
  participants,
  editable,
  onAdd,
  onRemove,
  className,
}: ParticipantChipsProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // Optimistic remove: the row goes at once; it comes back (with the error) if `onRemove` rejects.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const canAdd = editable && !!onAdd;
  const canRemove = editable && !!onRemove;

  async function remove(p: Participant) {
    if (!onRemove) return;
    setRemoved((prev) => new Set(prev).add(p.id));
    setError(null);
    try {
      await onRemove(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t remove them.');
      // The row (and the menu) may have gone with the optimistic remove: bring it back to show why.
      setMenuOpen(true);
    } finally {
      setRemoved((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    }
  }

  const shown = removed.size ? participants.filter((p) => !removed.has(p.id)) : participants;
  const count = shown.length;
  // Only me: nothing to show. Editors can still add people (revealed on hover, always on touch screens).
  if (count === 0 && !canAdd) return null;
  const only = shown[0];

  return (
    <>
      <DropdownMenu size="sm" open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          ref={trigger}
          className={cn(
            metaActionClass,
            count === 0 &&
              !adding &&
              'pointer-fine:opacity-0 pointer-fine:group-hover/meta:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100',
            className,
          )}
          aria-label={
            // Starts with what it shows (voice control targets the visible label), then who.
            count === 0
              ? 'Add attendees'
              : count === 1
                ? `Attendee: ${only?.name || only?.email}`
                : `${count} people: ${attendeesLabel(shown)}`
          }
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
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label="Attendees"
          className="w-64"
          data-testid="participant-details"
        >
          {count > 0 && (
            <DropdownMenuGroup data-testid="participants" data-count={count}>
              {shown.map((p) =>
                canRemove ? (
                  <DropdownMenuSub key={p.id}>
                    <DropdownMenuSubTrigger data-testid="participant-chip" data-source={p.source}>
                      <PersonRow participant={p} />
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem
                        variant="destructive"
                        aria-label={`Remove ${p.name || p.email}`}
                        closeOnClick={false}
                        onClick={() => void remove(p)}
                      >
                        <IconTrash />
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem
                    key={p.id}
                    data-testid="participant-chip"
                    data-source={p.source}
                  >
                    <PersonRow participant={p} />
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuGroup>
          )}
          {count === 0 && !canAdd && <DropdownMenuLabel>No attendees</DropdownMenuLabel>}
          {error && (
            <p role="alert" className="px-2 py-1 text-label-13 text-red-900">
              {error}
            </p>
          )}
          {canAdd && (
            <>
              {count > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem data-testid="add-participant" onClick={() => setAdding(true)}>
                <IconPlus />
                Add attendee
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canAdd && onAdd && (
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverContent anchor={trigger} align="start" aria-label="Add attendee">
            {adding && <AddParticipantForm onAdd={onAdd} onDone={() => setAdding(false)} />}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function PersonRow({ participant: p }: { participant: Participant }) {
  return (
    <>
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[9px] font-medium text-gray-1000"
      >
        {initials(p.name || p.email || '?')}
      </span>
      <span className="truncate">{p.name || p.email}</span>
      {p.email && p.name && p.email !== p.name && (
        <span className="min-w-0 truncate text-label-12 text-gray-900">{p.email}</span>
      )}
    </>
  );
}

function AddParticipantForm({
  onAdd,
  onDone,
}: {
  onAdd: NonNullable<ParticipantChipsProps['onAdd']>;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

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
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t add them.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate className="flex flex-col gap-2.5" onSubmit={(event) => void submit(event)}>
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
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
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
