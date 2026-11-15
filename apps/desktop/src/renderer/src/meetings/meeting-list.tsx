/**
 * Sidebar: "New meeting note" (creates the note and starts recording it) and the meeting notes on this Mac,
 * newest first (3.4), of the workspace the switcher shows (3.9). The one being recorded carries a live dot.
 */
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { shortWhen } from '@oat/meeting-ui';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { Loader2Icon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

export function NewMeetingButton({
  onClick,
  disabled,
  pending,
}: {
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <Button
      className="w-full justify-start"
      disabled={disabled || pending}
      onClick={onClick}
      data-testid="new-meeting"
    >
      {pending ? (
        <Loader2Icon data-icon="inline-start" className="animate-spin" />
      ) : (
        <PlusIcon data-icon="inline-start" />
      )}
      New meeting note
    </Button>
  );
}

export function MeetingList({
  notes,
  workspaceName = null,
  selected,
  recordingMeetingId,
  onSelect,
}: {
  notes: MeetingNoteSummary[] | null;
  /** 3.9: the workspace whose notes these are (the list is filtered by the switcher). */
  workspaceName?: string | null;
  selected: string | null;
  recordingMeetingId: string | null;
  onSelect: (documentId: string) => void;
}) {
  const [now] = useState(() => Date.now());
  return (
    <nav aria-label="Meeting notes" className="flex min-h-0 flex-1 flex-col gap-1">
      <h2 className="px-2.5 pt-1 text-xs font-medium text-muted-foreground">Meetings</h2>
      {notes === null ? null : notes.length === 0 ? (
        <p className="px-2.5 text-xs text-muted-foreground" data-testid="meeting-list-empty">
          {workspaceName
            ? `Meeting notes in ${workspaceName} appear here.`
            : 'Your meeting notes appear here.'}
        </p>
      ) : (
        <ul
          className="-mx-1 flex min-h-0 flex-col gap-px overflow-y-auto px-1"
          data-testid="meeting-list"
        >
          {notes.map((n) => {
            const active = n.documentId === selected;
            const recording = n.meetingId !== null && n.meetingId === recordingMeetingId;
            return (
              <li key={n.documentId}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  data-testid="meeting-list-item"
                  data-document-id={n.documentId}
                  onClick={() => onSelect(n.documentId)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-fast outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                  )}
                >
                  {recording && (
                    <span
                      aria-label="Recording"
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{n.title || 'Untitled meeting'}</span>
                  <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                    {shortWhen(n.startedAt ?? n.createdAt, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
