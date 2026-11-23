/**
 * Sidebar: "New meeting note" (creates the note and starts recording it) and the meeting notes on this Mac,
 * newest first (3.4), of the workspace the sidebar shows (3.9), under Private (mine and private — where a new
 * note starts) and Shared (everything else I can read), as on the web (D-36). The one being recorded carries
 * a live dot.
 */
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { SECTION_INFO, SIDEBAR_SECTIONS, splitSections } from '@oat/core/sections';
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
import { Button } from '@oat/ui/components/button';
import { Spinner } from '@oat/ui/components/spinner';
import { IconEdit, IconNotes } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { isNewNoteShortcut } from '../keyboard.ts';

export function NewMeetingButton({
  onClick,
  disabled,
  pending,
  sidebar = false,
}: {
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
  sidebar?: boolean;
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

  if (sidebar) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          className="app-no-drag"
          tooltip="New note · ⌘N"
          render={<button disabled={disabled || pending} />}
          aria-label="New note"
          disabled={disabled || pending}
          onClick={onClick}
          data-testid="new-meeting"
        >
          {pending ? <Spinner data-icon="inline-start" /> : <IconEdit />}
          <span>New note</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>
          <Kbd>⌘N</Kbd>
        </SidebarMenuBadge>
      </SidebarMenuItem>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      className="app-no-drag shrink-0"
      aria-label="New meeting note"
      disabled={disabled || pending}
      onClick={onClick}
      data-testid="new-meeting"
    >
      {pending ? <Spinner data-icon="inline-start" /> : <IconEdit />}
      <span>New meeting note</span>
    </Button>
  );
}

export function MeetingList({
  notes,
  userId,
  selected,
  recordingMeetingId,
  onSelect,
}: {
  /** The notes of the workspace the sidebar shows (3.9), newest first; `null` while loading. */
  notes: MeetingNoteSummary[] | null;
  /** The signed-in user: Private is what is theirs and private (D-36). */
  userId: string;
  selected: string | null;
  recordingMeetingId: string | null;
  onSelect: (documentId: string) => void;
}) {
  const [now] = useState(() => Date.now());
  if (notes === null) return null;
  // The same rule as the web sidebar (`@oat/core`): a note changes section when its visibility does.
  const sections = splitSections(notes, userId);
  return (
    <div data-testid={notes.length === 0 ? 'meeting-list-empty' : 'meeting-list'}>
      {SIDEBAR_SECTIONS.map((section) => (
        <SidebarGroup
          key={section}
          aria-label={`${SECTION_INFO[section].label} meeting notes`}
          data-testid={`meeting-section-${section}`}
        >
          <SidebarGroupLabel>{SECTION_INFO[section].label}</SidebarGroupLabel>
          {sections[section].length > 0 && (
            <SidebarMenu>
              {sections[section].map((n) => {
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
                      <span className="min-w-0 flex-1 truncate">
                        {n.title || 'Untitled meeting'}
                      </span>
                      <span
                        className={`shrink-0 text-label-12 tabular-nums ${active ? 'text-gray-1000' : 'text-gray-900'}`}
                      >
                        {shortWhen(n.startedAt ?? n.createdAt, now)}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>
      ))}
    </div>
  );
}
