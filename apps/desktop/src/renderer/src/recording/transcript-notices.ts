/**
 * What the transcript panel says about a meeting's transcript resilience (2.7): a crash recovery ("Oat quit
 * unexpectedly — recording saved up to 10:42 AM.") and the back-fill of transcription outages from the saved
 * audio ("Filling in 2 min of transcript…"). Pure, so the wording is unit-tested.
 */
import type { TranscriptBackfillStatus } from '@oat/core/bridge';

export type TranscriptNoticeKind = 'recovered' | 'filling' | 'retrying' | 'failed' | 'filled';

export interface TranscriptNotice {
  kind: TranscriptNoticeKind;
  text: string;
}

/** "45 s", "2 min", "1 h 5 min". */
export function formatSpan(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function transcriptNotices(
  status: TranscriptBackfillStatus | null,
  formatTime: (at: number) => string = (at) => TIME.format(at),
): TranscriptNotice[] {
  if (!status) return [];
  const out: TranscriptNotice[] = [];
  if (status.savedUntil !== null) {
    out.push({
      kind: 'recovered',
      text: `Oat quit unexpectedly — recording saved up to ${formatTime(status.savedUntil)}.`,
    });
  }
  if (status.pendingMs > 0) {
    out.push(
      status.retrying && !status.running
        ? {
            kind: 'retrying',
            text: `${formatSpan(status.pendingMs)} of transcript is still missing${
              status.error ? ` (${status.error.replace(/\.$/, '')})` : ''
            }. Oat will fill it in from the saved audio when it can.`,
          }
        : {
            kind: 'filling',
            text: `Filling in ${formatSpan(status.pendingMs)} of transcript from the saved audio…`,
          },
    );
  }
  if (status.failedMs > 0) {
    out.push({
      kind: 'failed',
      text: `${formatSpan(status.failedMs)} of audio couldn’t be transcribed${
        status.error ? `: ${status.error}` : '.'
      }`,
    });
  }
  if (status.pendingMs === 0 && status.failedMs === 0 && status.segments > 0) {
    out.push({
      kind: 'filled',
      text: `Part of this transcript (${formatSpan(status.doneMs)}) was filled in from the saved audio after transcription was interrupted.`,
    });
  }
  return out;
}
