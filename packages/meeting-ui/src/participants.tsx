'use client';

/**
 * Who was in the meeting: a facepile + names in the header (`ParticipantSummary`), chips in its popover: from the calendar event's attendees (7.3) or added by hand. Editors add
 * (name + optional email, in a popover) and remove them; the caller persists (web API / desktop local store).
 */
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from '@oat/ui/components/avatar';
import { Button } from '@oat/ui/components/button';
import { Input } from '@oat/ui/components/input';
import { Label } from '@oat/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@oat/ui/components/popover';
import { cn } from '@oat/ui/lib/utils';
import { Spinner } from '@oat/ui/components/spinner';
import { IconCalendar, IconPlus, IconUserPlus, IconX } from '@tabler/icons-react';
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
  const shown = participants.slice(0, count > MAX_FACES ? MAX_FACES - 1 : MAX_FACES);
  return (
    <Popover>
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
        ) : (
          <>
            <AvatarGroup className="-space-x-1">
              {shown.map((p) => (
                <Avatar key={p.id} size="sm" className="size-5">
                  <AvatarFallback className="bg-gray-200 text-[8px] font-medium text-gray-1000">
                    {initials(p.name || p.email || '?')}
                  </AvatarFallback>
                </Avatar>
              ))}
              {count > shown.length && (
                <AvatarGroupCount className="size-5 bg-gray-200 text-[8px] font-medium text-gray-1000">
                  +{count - shown.length}
                </AvatarGroupCount>
              )}
            </AvatarGroup>
            {attendeesLabel(participants)}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Attendees"
        className="max-h-72 w-80 overflow-y-auto"
        data-testid="participant-details"
      >
        <ParticipantChips {...props} />
      </PopoverContent>
    </Popover>
  );
}

const MAX_FACES = 3;

export function ParticipantChips({
  participants,
  editable,
  onAdd,
  onRemove,
  className,
}: ParticipantChipsProps) {
  // Optimistic remove: the chip goes at once; it comes back (with the error) if `onRemove` rejects.
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
    <div className={cn('flex flex-col gap-1', className)}>
      <ul
        aria-label="Attendees"
        className="flex flex-wrap items-center gap-1.5"
        data-testid="participants"
        data-count={shown.length}
      >
        {shown.map((p) => (
          <li
            key={p.id}
            data-testid="participant-chip"
            data-source={p.source}
            title={p.email ?? undefined}
            className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-gray-alpha-400 bg-background-100 ps-0.5 pe-2.5 text-label-13 text-gray-1000 has-[button]:pe-0.5"
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-label-12 text-gray-1000"
            >
              {initials(p.name || p.email || '?')}
            </span>
            <span className="truncate">{p.name || p.email}</span>
            {p.source === 'calendar' && (
              <IconCalendar
                aria-label="From the calendar"
                className="size-3 shrink-0 text-gray-900"
              />
            )}
            {editable && onRemove && (
              <button
                type="button"
                aria-label={`Remove ${p.name || p.email}`}
                onClick={() => void remove(p)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-gray-900 transition-colors hover:bg-gray-alpha-200 hover:text-gray-1000 focus-visible:ring-3 focus-visible:ring-gray-600/50 focus-visible:outline-none"
              >
                <IconX className="size-3" />
              </button>
            )}
          </li>
        ))}
        {editable && onAdd && (
          <li>
            <AddParticipant onAdd={onAdd} />
          </li>
        )}
        {shown.length === 0 && !(editable && onAdd) && (
          <li className="text-label-13 text-gray-900">No attendees</li>
        )}
      </ul>
      {error && (
        <p role="alert" className="text-label-13 text-red-900">
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
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-button-12 text-gray-900"
            data-testid="add-participant"
          />
        }
      >
        <IconPlus data-icon="inline-start" />
        Add attendee
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
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
          <Button type="submit" size="sm" disabled={pending} className="self-end">
            {pending && <Spinner data-icon="inline-start" />}
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
