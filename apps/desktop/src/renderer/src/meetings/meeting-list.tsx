/**
 * Sidebar: "New meeting note" (creates the note and starts recording it) and the meeting notes on this Mac,
 * newest first (3.4), of the workspace the switcher shows (3.9). The one being recorded carries a live dot.
 */
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { shortWhen } from '@oat/meeting-ui';
import { Button } from '@oat/ui/components/button';
import { cn } from '@oat/ui/lib/utils';
import { Kbd, KbdGroup } from '@oat/ui/components/kbd';
import { Spinner } from '@oat/ui/components/spinner';
import { IconPlus } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { isNewNoteShortcut } from '../keyboard.ts';

/** The platform's command key, for shortcut hints. */
export const MOD =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function NewMeetingButton({
  onClick,
  disabled,
  pending,
}: {
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
}) {
  useEffect(() => {
    if (disabled || pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isNewNoteShortcut(event)) return;
      event.preventDefault();
      onClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, pending, onClick]);

  return (
    <Button
      className="w-full justify-start"
      disabled={disabled || pending}
      onClick={onClick}
      data-testid="new-meeting"
    >
      {pending ? <Spinner data-icon="inline-start" /> : <IconPlus data-icon="inline-start" />}
      New meeting note
      <KbdGroup aria-hidden className="ms-auto">
        <Kbd className="bg-background-100/20 text-background-100">{MOD}</Kbd>
        <Kbd className="bg-background-100/20 text-background-100">N</Kbd>
      </KbdGroup>
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
      <h2 className="flex h-8 items-center px-2.5 text-label-12 text-gray-900">Meetings</h2>
      {notes === null ? null : notes.length === 0 ? (
        <p className="px-2.5 text-copy-13 text-gray-900" data-testid="meeting-list-empty">
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
                    'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-start text-label-14 text-gray-1000 transition-colors outline-none hover:bg-gray-alpha-100 focus-visible:ring-3 focus-visible:ring-gray-600/50 active:bg-gray-alpha-200',
                    active && 'bg-gray-alpha-200 hover:bg-gray-alpha-300',
                  )}
                >
                  {recording && (
                    <span
                      aria-label="Recording"
                      className="size-1.5 shrink-0 animate-pulse rounded-full bg-red-700"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{n.title || 'Untitled meeting'}</span>
                  <span className="shrink-0 text-label-12 text-gray-900 tabular-nums">
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
