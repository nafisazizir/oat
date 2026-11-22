import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from './page';

const shell = vi.hoisted(() => ({
  getShellData: vi.fn(),
}));

vi.mock('@/server/shell', () => shell);
vi.mock('@/components/app-shell/new-note-button', () => ({
  NewNoteButton: () => <button>New note</button>,
}));
vi.mock('@/components/calendar/upcoming-meetings', () => ({
  UpcomingMeetings: () => <div>Upcoming meetings</div>,
  UpcomingMeetingsSkeleton: () => <div>Loading meetings</div>,
}));

describe('Home', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    shell.getShellData.mockResolvedValue({ documents: [] });
  });

  it('shows a shared empty state without duplicating the shell note action', async () => {
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('No notes yet');
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain('Create a note or start a meeting to capture what matters.');
    expect(html).not.toContain('New note');
    expect(html).not.toContain('Pages you edit show up here.');
    expect(html).toContain('Upcoming meetings');
  });

  it('links recent notes and pages without redundant sharing metadata', async () => {
    const document = {
      id: 'note-1',
      title: 'Design sync',
      kind: 'meeting',
      updatedAt: '2026-01-01T12:00:00Z',
    };
    shell.getShellData.mockResolvedValue({
      documents: [document, { ...document, id: 'page-1', title: 'Ideas', kind: 'page' }],
    });
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain('href="/d/note-1"');
    expect(html).toContain('href="/d/page-1"');
    expect(html).toContain('Design sync');
    expect(html).toContain('Ideas');
    expect(html).not.toContain('No meeting notes yet');
    expect(html).not.toContain('Shared ·');
    expect(html).not.toContain('Private ·');
    expect(html).toContain('data-testid="home-notes"');
  });

  it('lets loader failures reach the route error boundary', async () => {
    shell.getShellData.mockRejectedValue(new Error('Unavailable'));
    await expect(HomePage()).rejects.toThrow('Unavailable');
  });
});
