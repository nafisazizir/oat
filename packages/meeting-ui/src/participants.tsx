'use client';

/**
 * Who was in the meeting, as chips: from the calendar event's attendees (7.3) or added by hand. Editors add
 * (name + optional email, in a popover) and remove them; the caller persists (web API / desktop local store).
 */
import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { cn } from '@oat/ui/lib/utils';
import { CalendarIcon, Loader2Icon, PlusIcon, XIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { initials, isPlausibleEmail, type Participant } from './format.ts';

export interface ParticipantChipsProps {
  participants: readonly Participant[];
  editable: boolean;
  /** Rejects with a user-facing message (shown in the form). */
  onAdd?: (input: { name: string; email: string | null }) => Promise<void>;
  onRemove?: (participant: Participant) => Promise<void>;
  className?: string;
}

export const MAX_PARTICIPANT_NAME = 200;

export function ParticipantChips({
  participants,
  editable,
  onAdd,
  onRemove,
  className,
}: ParticipantChipsProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(p: Participant) {
    if (!onRemove) return;
    setRemoving(p.id);
    setError(null);
    try {
      await onRemove(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t remove them.');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <ul
        aria-label="Attendees"
        className="flex flex-wrap items-center gap-1.5"
        data-testid="participants"
        data-count={participants.length}
      >
        {participants.map((p) => (
          <li
            key={p.id}
            data-testid="participant-chip"
            data-source={p.source}
            title={p.email ?? undefined}
            className="group inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border bg-card pr-2.5 pl-0.5 text-xs text-card-foreground"
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[0.625rem] font-semibold text-accent-foreground"
            >
              {initials(p.name || p.email || '?')}
            </span>
            <span className="truncate">{p.name || p.email}</span>
            {p.source === 'calendar' && (
              <CalendarIcon
                aria-label="From the calendar"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
            {editable && onRemove && (
              <button
                type="button"
                aria-label={`Remove ${p.name || p.email}`}
                disabled={removing === p.id}
                onClick={() => void remove(p)}
                className="-mr-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-60 transition-opacity duration-fast group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40"
              >
                {removing === p.id ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <XIcon className="size-3" />
                )}
              </button>
            )}
          </li>
        ))}
        {editable && onAdd && (
          <li>
            <AddParticipant onAdd={onAdd} />
          </li>
        )}
        {participants.length === 0 && !(editable && onAdd) && (
          <li className="text-xs text-muted-foreground">No attendees</li>
        )}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
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

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
          data-testid="add-participant"
        >
          <PlusIcon data-icon="inline-start" />
          Add attendee
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form noValidate className="flex flex-col gap-2.5" onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`} className="text-xs">
              Name
            </Label>
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
            <Label htmlFor={`${id}-email`} className="text-xs">
              Email <span className="font-normal text-muted-foreground">(optional)</span>
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
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={pending} className="self-end">
            {pending && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
