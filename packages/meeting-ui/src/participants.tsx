'use client';

/**
 * Who was in the meeting: "N people" in the header, a small row menu behind it with one row per person
 * (from the calendar event's attendees, 7.3, or added by hand). Editors remove someone with their row's
 * trash button; the caller persists (web API / desktop local store).
 */
import { Avatar, AvatarFallback } from '@oat/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oat/ui/components/dropdown-menu';
import { cn } from '@oat/ui/lib/utils';
import { IconTrash, IconUser, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';

import { attendeesLabel, initials, type Participant } from './format.ts';
import { metaActionClass } from './meeting-meta.tsx';

export interface ParticipantChipsProps {
  participants: readonly Participant[];
  editable: boolean;
  onRemove?: (participant: Participant) => Promise<void>;
  className?: string;
}

export function ParticipantSummary({
  participants,
  editable,
  onRemove,
  className,
}: ParticipantChipsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Optimistic remove: the row goes at once; it comes back (with the error) if `onRemove` rejects.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
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
  // Only me: nothing to show.
  if (count === 0) return null;
  const only = shown[0];

  return (
    <DropdownMenu size="sm" open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        className={cn(metaActionClass, className)}
        aria-label={
          // Starts with what it shows (voice control targets the visible label), then who.
          count === 1
            ? `Attendee: ${only?.name || only?.email}`
            : `${count} people: ${attendeesLabel(shown)}`
        }
        data-testid="attendees-toggle"
        data-count={count}
      >
        {count === 1 && only ? (
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
        <DropdownMenuGroup data-testid="participants" data-count={count}>
          {shown.map((p) => (
            <div
              key={p.id}
              className="flex min-w-0 items-center gap-1"
              data-testid="participant-chip"
              data-source={p.source}
            >
              <DropdownMenuItem
                className="min-w-0 flex-1"
                title={p.email && p.email !== p.name ? `${p.name} <${p.email}>` : p.name}
              >
                <PersonRow participant={p} />
              </DropdownMenuItem>
              {canRemove && (
                <DropdownMenuItem
                  aria-label={`Remove ${p.name || p.email}`}
                  title="Remove"
                  closeOnClick={false}
                  onClick={() => void remove(p)}
                  className="size-6 shrink-0 justify-center p-0 text-gray-900"
                >
                  <IconTrash className="size-3.5" />
                </DropdownMenuItem>
              )}
            </div>
          ))}
        </DropdownMenuGroup>
        {error && (
          <p role="alert" className="px-2 py-1 text-label-13 text-red-900">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonRow({ participant: p }: { participant: Participant }) {
  return (
    <>
      <Avatar size="sm" aria-hidden>
        <AvatarFallback>{initials(p.name || p.email || '?')}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{p.name || p.email}</span>
      {p.email && p.name && p.email !== p.name && (
        <span className="min-w-0 truncate text-label-12 text-gray-900">{p.email}</span>
      )}
    </>
  );
}
