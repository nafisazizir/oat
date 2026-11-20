/**
 * Sidebar: "New meeting note" (creates the note and starts recording it) and the meeting notes on this Mac,
 * newest first (3.4), of the workspace the switcher shows (3.9). The one being recorded carries a live dot.
 */
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { shortWhen } from '@oat/meeting-ui';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
} from '@oat/ui/components/sidebar';
import { Kbd } from '@oat/ui/components/kbd';
import { Spinner } from '@oat/ui/components/spinner';
import { IconEdit, IconNotes } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { isNewNoteShortcut } from '../keyboard.ts';

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
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip="New note"
        className="text-brand-900 hover:text-brand-1000"
        aria-label="New meeting note"
        disabled={disabled || pending}
        onClick={onClick}
        data-testid="new-meeting"
      >
        {pending ? <Spinner data-icon="inline-start" /> : <IconEdit />}
        <span>New meeting note</span>
      </SidebarMenuButton>
      <SidebarMenuBadge>
        <Kbd>⌘N</Kbd>
      </SidebarMenuBadge>
    </SidebarMenuItem>
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
    <SidebarGroup aria-label="Meeting notes">
      <SidebarGroupLabel>Meetings</SidebarGroupLabel>
      {notes === null ? null : notes.length === 0 ? (
        <p className="px-2.5 text-copy-13 text-gray-900" data-testid="meeting-list-empty">
          {workspaceName
            ? `Meeting notes in ${workspaceName} appear here.`
            : 'Your meeting notes appear here.'}
        </p>
      ) : (
        <SidebarMenu data-testid="meeting-list">
          {notes.map((n) => {
            const active = n.documentId === selected;
            const recording = n.meetingId !== null && n.meetingId === recordingMeetingId;
            return (
              <SidebarMenuItem key={n.documentId}>
                <SidebarMenuButton
                  isActive={active}
                  tooltip={n.title || 'Untitled meeting'}
                  aria-current={active ? 'page' : undefined}
                  data-testid="meeting-list-item"
                  data-document-id={n.documentId}
                  onClick={() => onSelect(n.documentId)}
                >
                  <IconNotes aria-hidden />
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
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
