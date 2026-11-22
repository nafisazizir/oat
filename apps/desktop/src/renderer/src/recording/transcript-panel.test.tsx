// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TranscriptPanel } from './transcript-panel';

afterEach(cleanup);
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
