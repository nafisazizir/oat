// @vitest-environment jsdom
import type { MeetingNoteSummary } from '@oat/core/bridge';
import { SidebarProvider } from '@oat/ui/components/sidebar';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingList } from './meeting-list.tsx';

const ME = 'me';

const note = (
  documentId: string,
  visibility: MeetingNoteSummary['visibility'],
  ownerId = ME,
): MeetingNoteSummary => ({
  documentId,
  meetingId: null,
  workspaceId: 'ws',
  ownerId,
  title: documentId,
  visibility,
  startedAt: null,
  endedAt: null,
  createdAt: '2026-11-20T10:00:00.000Z',
});

const list = (notes: MeetingNoteSummary[] | null) => (
  <SidebarProvider>
    <MeetingList
      notes={notes}
      userId={ME}
      selected={null}
      recordingMeetingId={null}
      onSelect={() => {}}
    />
  </SidebarProvider>
);

const titles = (section: 'private' | 'shared') =>
  within(screen.getByTestId(`meeting-section-${section}`))
    .queryAllByTestId('meeting-list-item')
    .map((row) => row.getAttribute('data-document-id'));

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MeetingList: Private and Shared (D-36)', () => {
  it('puts my private notes under Private and everything else under Shared, in list order', () => {
    render(
      list([
        note('mine-private', 'private'),
        note('mine-shared', 'workspace'),
        note('theirs', 'workspace', 'teammate'),
        note('mine-private-2', 'private'),
        note('theirs-link', 'link', 'teammate'),
      ]),
    );
    expect(titles('private')).toEqual(['mine-private', 'mine-private-2']);
    expect(titles('shared')).toEqual(['mine-shared', 'theirs', 'theirs-link']);
    // Private first: it is where a new note starts.
    const labels = screen.getAllByText(/^(Private|Shared)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Private', 'Shared']);
  });

  it('moves a note to the other section when its visibility changes, without remounting the list', () => {
    const view = render(list([note('standup', 'private')]));
    expect(titles('private')).toEqual(['standup']);
    expect(titles('shared')).toEqual([]);
    // Sync brought the change (shared on the web): the next list from main says `workspace`.
    view.rerender(list([note('standup', 'workspace')]));
    expect(titles('private')).toEqual([]);
    expect(titles('shared')).toEqual(['standup']);
    view.rerender(list([note('standup', 'private')]));
    expect(titles('private')).toEqual(['standup']);
  });

  it('shows an empty section as just its label', () => {
    render(list([]));
    expect(screen.getByTestId('meeting-section-private').textContent).toBe('Private');
    expect(screen.getByTestId('meeting-section-shared').textContent).toBe('Shared');
    // No notes at all: the list as a whole is marked empty.
    expect(screen.getByTestId('meeting-list-empty')).toBeTruthy();
    expect(screen.queryByTestId('meeting-list')).toBeNull();
  });

  it('shows nothing until the notes are loaded', () => {
    render(list(null));
    expect(screen.queryByTestId('meeting-section-private')).toBeNull();
    expect(screen.queryByTestId('meeting-section-shared')).toBeNull();
  });
});
