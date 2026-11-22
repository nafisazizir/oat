// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeDocuments, type HomeDocument } from './home-model';
import { HomeDocuments } from './home-documents';
import type { DocumentNode } from './tree';
afterEach(cleanup);
const page: DocumentNode = {
  id: 'page',
  title: 'Page',
  kind: 'page',
  updatedAt: '2026-11-21T10:00:00Z',
  access: { edit: true, delete: true },
  visibility: 'private',
  ownerId: 'u',
  parentId: null,
};
const meeting: HomeDocument = {
  id: 'meeting',
  kind: 'meeting',
  title: 'Meeting',
  updatedAt: '2026-11-21T11:00:00Z',
  pending: true,
  meetingId: 'm',
};
describe('shared Home model', () => {
  it('merges server pages and pending meetings newest first without duplicates', () => {
    const remoteMeeting = {
      ...page,
      ...meeting,
      title: 'Server meeting',
      updatedAt: page.updatedAt,
    };
    const result = homeDocuments([page, remoteMeeting], [meeting]);
    expect(result.map((doc) => doc.id)).toEqual(['meeting', 'page']);
    expect(result[0]).toMatchObject({ title: 'Meeting', pending: true, meetingId: 'm' });
    expect(homeDocuments([page], [meeting])).toHaveLength(2);
  });
  it('does not promote unlisted cached notes online or resurrect folders/trash', () => {
    expect(
      homeDocuments(
        [page, { ...page, id: 'folder', kind: 'folder' }],
        [{ ...meeting, pending: false }],
      ),
    ).toEqual([{ id: 'page', title: 'Page', kind: 'page', updatedAt: page.updatedAt }]);
    expect(
      homeDocuments([page], [meeting], { trash: [{ id: 'meeting' }, { id: 'page' }] }),
    ).toEqual([]);
    expect(homeDocuments([{ ...page, deletedAt: page.updatedAt }])).toEqual([]);
  });
  it('preserves the server title for synced notes and cached notes when offline', () => {
    expect(
      homeDocuments(
        [{ ...page, kind: 'meeting', id: meeting.id }],
        [{ ...meeting, pending: false }],
      )[0]?.title,
    ).toBe('Page');
    expect(
      homeDocuments([], [{ ...meeting, pending: false }], { includeCached: true }),
    ).toHaveLength(1);
    expect(homeDocuments([], [])).toEqual([]);
  });
});
it('shares empty, pending/recording, title fallback and document opening presentation', () => {
  const open = vi.fn();
  const { rerender } = render(<HomeDocuments documents={[]} onOpen={open} />);
  expect(screen.getByTestId('home-empty')).toBeTruthy();
  rerender(
    <HomeDocuments documents={[{ ...meeting, title: '' }]} onOpen={open} recordingMeetingId="m" />,
  );
  expect(screen.getByText('Untitled')).toBeTruthy();
  expect(screen.getByText('Pending sync')).toBeTruthy();
  expect(screen.getByText('Recording')).toBeTruthy();
  fireEvent.click(screen.getByTestId('home-note-row'));
  expect(open).toHaveBeenCalledWith('meeting');
});
