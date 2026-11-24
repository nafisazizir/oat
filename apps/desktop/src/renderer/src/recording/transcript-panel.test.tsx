// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { RecordingSnapshot } from '@oat/core/bridge';
import { afterEach, expect, it } from 'vitest';
import { TranscriptPanel } from './transcript-panel';

afterEach(cleanup);

const liveSnapshot: RecordingSnapshot = {
  seq: 0,
  status: 'recording',
  meetingId: 'meeting',
  input: 'sidecar',
  fixture: null,
  startedAt: 1,
  elapsedMs: 0,
  elapsedAt: 0,
  levels: { mic: null, system: null },
  stt: { mic: 'open', system: 'open' },
  issues: [],
};

it('leaves the live transcript blank until lines arrive', () => {
  const props = {
    live: true,
    snapshot: liveSnapshot,
    loaded: true,
    failed: false,
    meetingKey: 'meeting',
  };
  const { rerender } = render(<TranscriptPanel {...props} segments={[]} />);
  expect(screen.getByTestId('transcript').firstChild).toBeNull();
  rerender(
    <TranscriptPanel
      {...props}
      segments={[{ id: 'line', source: 'mic', startMs: 0, endMs: 1, text: 'Hello', isFinal: true }]}
    />,
  );
  expect(screen.getByTestId('transcript').getAttribute('data-count')).toBe('1');
  expect(screen.getByTestId('transcript-scroll')).toBeTruthy();
});

it('keeps the offline warning when a live transcript is empty', () => {
  render(
    <TranscriptPanel
      segments={[]}
      live
      snapshot={{ ...liveSnapshot, stt: { mic: 'error', system: 'idle' } }}
      loaded
      failed={false}
      meetingKey="meeting"
    />,
  );
  expect(screen.getByText('Waiting for transcription')).toBeTruthy();
});

it('shows a successfully loaded empty remote transcript without an error', () => {
  render(
    <TranscriptPanel
      segments={[]}
      live={false}
      snapshot={null}
      loaded
      failed={false}
      meetingKey="remote"
    />,
  );
  expect(screen.getByText('No transcript yet')).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
  expect(screen.queryByText('Couldn’t load the transcript. Retrying…')).toBeNull();
});
