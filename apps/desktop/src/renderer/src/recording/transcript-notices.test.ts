import type { TranscriptBackfillStatus } from '@oat/core/bridge';
import { describe, expect, it } from 'vitest';

import { formatSpan, transcriptNotices } from './transcript-notices.ts';

const base: TranscriptBackfillStatus = {
  meetingId: 'm1',
  pendingMs: 0,
  doneMs: 0,
  failedMs: 0,
  segments: 0,
  running: false,
  retrying: false,
  error: null,
  recoveredAt: null,
  savedUntil: null,
};
const notices = (patch: Partial<TranscriptBackfillStatus>) =>
  transcriptNotices({ ...base, ...patch }, () => '10:42 AM');

describe('transcript notices (2.7)', () => {
  it('formats spans', () => {
    expect(formatSpan(400)).toBe('1 s');
    expect(formatSpan(45_000)).toBe('45 s');
    expect(formatSpan(120_000)).toBe('2 min');
    expect(formatSpan(150_000)).toBe('3 min');
    expect(formatSpan(3_900_000)).toBe('1 h 5 min');
    expect(formatSpan(7_200_000)).toBe('2 h');
  });

  it('nothing to say → nothing shown', () => {
    expect(transcriptNotices(null)).toEqual([]);
    expect(notices({})).toEqual([]);
  });

  it('crash recovery', () => {
    expect(notices({ recoveredAt: 1, savedUntil: 2 })).toEqual([
      { kind: 'recovered', text: 'Oat quit unexpectedly — recording saved up to 10:42 AM.' },
    ]);
  });

  it('filling, retrying, failed, filled', () => {
    expect(notices({ pendingMs: 120_000, running: true })).toEqual([
      { kind: 'filling', text: 'Filling in 2 min of transcript from the saved audio…' },
    ]);
    expect(
      notices({
        pendingMs: 120_000,
        retrying: true,
        error: 'Transcription is unavailable right now.',
      }),
    ).toEqual([
      {
        kind: 'retrying',
        text: '2 min of transcript is still missing (Transcription is unavailable right now). Oat will fill it in from the saved audio when it can.',
      },
    ]);
    expect(
      notices({ failedMs: 30_000, error: 'The audio of this part is no longer on this Mac.' }),
    ).toEqual([
      {
        kind: 'failed',
        text: '30 s of audio couldn’t be transcribed: The audio of this part is no longer on this Mac.',
      },
    ]);
    expect(notices({ doneMs: 95_000, segments: 4 })).toEqual([
      {
        kind: 'filled',
        text: 'Part of this transcript (2 min) was filled in from the saved audio after transcription was interrupted.',
      },
    ]);
  });
});
