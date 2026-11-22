// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingView } from './meeting-view.tsx';
import type { ReactNode } from 'react';

vi.mock('@oat/feature-ui/assistant', async (original) => ({
  ...(await original<object>()),
  DocumentAssistant: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@oat/workspace-ui/host', () => ({ useWorkspaceHost: () => ({ navigate: vi.fn() }) }));
vi.mock('@oat/feature-ui/document', () => ({
  NotionExportButton: () => null,
  useDocumentEnhancement: () => ({
    streaming: false,
    beforeEditor: null,
    secondary: (_workspace: string, render: (node: ReactNode) => ReactNode) => render(null),
  }),
}));

const model = vi.hoisted(() => ({
  note: null as unknown,
  loaded: true,
  pause: vi.fn(),
  call: vi.fn(),
  seek: vi.fn(),
  playable: false,
  failure: undefined as string | undefined,
  retry: vi.fn(),
  segments: [] as { id: string; source: 'mic'; startMs: number; endMs: number; text: string }[],
  scroll: vi.fn(),
}));
vi.mock('../bridge.ts', () => ({ call: model.call, BridgeCallError: class extends Error {} }));
vi.mock('@oat/editor/react', async (original) => ({
  ...(await original<object>()),
  OatEditor: () => (
    <div className="oat-editor">
      <p data-id="block">Editor</p>
    </div>
  ),
}));
vi.mock('../recording-state.ts', () => ({
  useTranscript: () => ({ meetingId: null, segments: [], loaded: true, failed: false }),
}));
vi.mock('../auto-stop/auto-stop-state.ts', () => ({ useMeetingGrace: () => null }));
vi.mock('./post-meeting.tsx', () => ({ GraceLine: () => null, PipelineLine: () => null }));
vi.mock('../recording/transcript-panel.tsx', () => ({
  TranscriptPanel: ({ focusId, onSelect }: { focusId?: string; onSelect?(s: unknown): void }) => (
    <>
      <p data-testid="focused" data-focus-id={focusId}>
        Transcript content
      </p>
      <button onClick={() => onSelect?.({ id: 'other', startMs: 9999 })}>Pick other</button>
    </>
  ),
}));
vi.mock('./audio-player.tsx', () => ({
  useMeetingPlayback: () => ({
    audioRef: { current: null },
    player: {
      available: model.playable,
      seek: model.seek,
      pause: model.pause,
      clock: { subscribe: () => () => {}, ms: 0 },
    },
  }),
  PlaybackBar: () => null,
  playerKey: () => {},
}));
vi.mock('./meetings-state.ts', () => ({
  useMeetingNote: () => ({
    note: model.note,
    loaded: model.loaded,
    failure: model.failure,
    retry: model.retry,
  }),
  useStoredTranscript: () => ({ segments: model.segments, loaded: true, failed: false }),
  useTranscriptStatus: () => null,
  registerFlush: () => () => {},
}));
const note = {
  documentId: 'doc',
  meetingId: 'meeting',
  workspaceId: 'own',
  workspaceName: 'Ada’s workspace',
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
  model.seek.mockReset();
  model.scroll.mockReset();
  model.retry.mockReset();
  model.playable = false;
  model.failure = undefined;
  model.segments = [];
  vi.stubGlobal('CSS', { escape: (id: string) => id });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Element.prototype.scrollIntoView = model.scroll;
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
    expect(screen.getByText('Page not found')).toBeTruthy();
  });
  it.each([
    ['missing', 'Page not found'],
    ['offline', 'This meeting isn’t available offline'],
    ['error', 'Couldn’t load this meeting'],
  ])('renders %s with retry', (failure, title) => {
    model.note = null;
    model.failure = failure;
    render(<MeetingView {...props} />);
    expect(screen.getByText(title!)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(model.retry).toHaveBeenCalledOnce();
  });
  it('defers transcript focus until load, opens the panel, and re-focuses identical citations', async () => {
    model.note = null;
    model.loaded = false;
    const focus = { seg: 'segment', t: '9', block: 'block' };
    const view = render(<MeetingView {...props} focus={focus} focusRevision={1} />);
    model.note = note;
    model.loaded = true;
    model.segments = [{ id: 'segment', source: 'mic', startMs: 1000, endMs: 2000, text: 'Hello' }];
    view.rerender(<MeetingView {...props} focus={focus} focusRevision={1} />);
    await waitFor(() =>
      expect(screen.getByTestId('focused').getAttribute('data-focus-id')).toBe('segment'),
    );
    expect(model.scroll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Pick other' }));
    expect(screen.getByTestId('focused').getAttribute('data-focus-id')).toBe('other');
    view.rerender(<MeetingView {...props} focus={focus} focusRevision={2} />);
    await waitFor(() =>
      expect(screen.getByTestId('focused').getAttribute('data-focus-id')).toBe('segment'),
    );
    expect(model.scroll).toHaveBeenCalledTimes(2);
  });
  it('seeks loaded audio by segment (before time), re-seeks repeated links and falls back to time', () => {
    model.playable = true;
    model.segments = [{ id: 'segment', source: 'mic', startMs: 1000, endMs: 2000, text: 'Hello' }];
    const focus = { seg: 'segment', t: '9' };
    const view = render(<MeetingView {...props} focus={focus} focusRevision={1} />);
    expect(model.seek).toHaveBeenLastCalledWith(1000);
    view.rerender(<MeetingView {...props} focus={focus} focusRevision={2} />);
    expect(model.seek).toHaveBeenCalledTimes(2);
    view.rerender(
      <MeetingView {...props} focus={{ seg: 'unknown', t: '1.5' }} focusRevision={3} />,
    );
    expect(model.seek).toHaveBeenLastCalledWith(1500);
  });
});
