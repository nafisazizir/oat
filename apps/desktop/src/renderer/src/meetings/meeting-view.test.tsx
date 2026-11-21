// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingView } from './meeting-view.tsx';

const model = vi.hoisted(() => ({
  note: null as unknown,
  loaded: true,
  pause: vi.fn(),
  call: vi.fn(),
}));
vi.mock('../bridge.ts', () => ({ call: model.call, BridgeCallError: class extends Error {} }));
vi.mock('@oat/editor/react', () => ({ OatEditor: () => <div>Editor</div> }));
vi.mock('../recording-state.ts', () => ({
  useTranscript: () => ({ meetingId: null, segments: [], loaded: true, failed: false }),
}));
vi.mock('../auto-stop/auto-stop-state.ts', () => ({ useMeetingGrace: () => null }));
vi.mock('./post-meeting.tsx', () => ({ GraceLine: () => null, PipelineLine: () => null }));
vi.mock('../recording/transcript-panel.tsx', () => ({
  TranscriptPanel: () => <p>Transcript content</p>,
}));
vi.mock('./audio-player.tsx', () => ({
  useMeetingPlayback: () => ({
    audioRef: { current: null },
    player: { available: false, pause: model.pause, clock: { subscribe: () => () => {}, ms: 0 } },
  }),
  PlaybackBar: () => null,
  playerKey: () => {},
}));
vi.mock('./meetings-state.ts', () => ({
  useMeetingNote: () => ({ note: model.note, loaded: model.loaded }),
  useStoredTranscript: () => ({ segments: [], loaded: true, failed: false }),
  useTranscriptStatus: () => null,
  registerFlush: () => () => {},
}));
const note = {
  documentId: 'doc',
  meetingId: 'meeting',
  workspaceId: 'personal',
  workspaceName: 'Personal',
  title: 'Weekly sync',
  contentJson: { type: 'doc', content: [] },
  visibility: 'private',
  editable: true,
  recordedHere: true,
  trashed: false,
  startedAt: '2026-11-21T10:00:00Z',
  endedAt: '2026-11-21T10:30:00Z',
  updatedAt: '2026-11-21T10:30:00Z',
  participants: [],
  calendarEvent: null,
};
const props = {
  userId: 'alice',
  documentId: 'doc',
  snapshot: null,
  options: null,
  input: 'sidecar',
  onInputChange: () => {},
};
beforeEach(() => {
  localStorage.clear();
  model.note = note;
  model.loaded = true;
  model.pause.mockReset();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 1;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('calm meeting surface', () => {
  it('defaults closed and groups recording with the toggle; persists open for this user', async () => {
    const first = render(<MeetingView {...props} />);
    expect(screen.queryByTestId('transcript-panel')).toBeNull();
    expect(
      screen.getByTestId('note-bottom-bar').contains(screen.getByTestId('recording-bar')),
    ).toBe(true);
    await userEvent.click(screen.getByTestId('transcript-toggle'));
    expect(screen.getByTestId('transcript-panel')).toBeTruthy();
    expect(screen.getByTestId('note-bottom-bar').parentElement).toBe(
      screen.getByRole('region', { name: 'Meeting' }),
    );
    expect(screen.getByTestId('transcript-panel').parentElement).not.toBe(
      screen.getByTestId('note-bottom-bar').parentElement,
    );
    expect(localStorage.getItem('oat.desktop.transcript.open:alice')).toBe('true');
    first.unmount();
    render(<MeetingView {...props} />);
    await waitFor(() => expect(screen.getByTestId('transcript-panel')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('transcript-panel')).toBeNull();
    expect(model.pause).toHaveBeenCalled();
    expect(localStorage.getItem('oat.desktop.transcript.open:alice')).toBe('false');
  });
  it('does not inherit another user’s open state and supports the close button and pill', async () => {
    localStorage.setItem('oat.desktop.transcript.open:bob', 'true');
    render(<MeetingView {...props} />);
    expect(screen.queryByTestId('transcript-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('transcript-toggle'));
    await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.queryByTestId('transcript-panel')).toBeNull();
    await userEvent.click(screen.getByTestId('transcript-toggle'));
    await userEvent.click(screen.getByTestId('transcript-toggle'));
    expect(screen.queryByTestId('transcript-panel')).toBeNull();
  });
  it('keeps missing and loading note states reachable', () => {
    model.note = null;
    model.loaded = false;
    const view = render(<MeetingView {...props} />);
    expect(screen.getByTestId('note-loading')).toBeTruthy();
    model.loaded = true;
    view.rerender(<MeetingView {...props} />);
    expect(screen.getByText('This note isn’t on this Mac anymore')).toBeTruthy();
  });
});
