/**
 * The meeting side of a `meeting` note on the web (3.4): when it was recorded, who was there, and (on
 * request) its transcript. Shapes of `src/server/meeting.ts` + a small browser client.
 *
 *   GET    /api/documents/:id/meeting[?transcript=1[&after=<ms>]]  MeetingInfo (readers)
 *   POST   /api/documents/:id/participants  { name, email? }  → 201 MeetingParticipant (editors)
 *   DELETE /api/documents/:id/participants/:participantId     → 204 (editors)
 */
import type { Participant } from '@oat/meeting-ui/format';

import { ApiRequestError, request } from './api-client';
import type { TranscriptLine } from './transcript';

export type MeetingParticipant = Participant;

export type MeetingInfo = {
  /** `null`: a meeting note that was never recorded and has no attendees yet. */
  meetingId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  participants: MeetingParticipant[];
  /** Only with `?transcript=1`. */
  transcript?: TranscriptLine[];
};

export type AddParticipantInput = { name: string; email: string | null };

const enc = encodeURIComponent;

export const meetingApi = {
  /** `after`: only transcript lines starting at or after it (ms). */
  get: (documentId: string, opts: { transcript?: boolean; after?: number } = {}) =>
    request<MeetingInfo>(
      'GET',
      `/api/documents/${enc(documentId)}/meeting${
        opts.transcript
          ? `?transcript=1${opts.after ? `&after=${Math.floor(opts.after)}` : ''}`
          : ''
      }`,
    ),
  addParticipant: (documentId: string, input: AddParticipantInput) =>
    request<MeetingParticipant>('POST', `/api/documents/${enc(documentId)}/participants`, input),
  removeParticipant: (documentId: string, participantId: string) =>
    request<void>('DELETE', `/api/documents/${enc(documentId)}/participants/${enc(participantId)}`),
};

/**
 * Live polling (3.4): the lines before `fromMs` as we have them, then what the server sent from `fromMs` on
 * (it re-sends the lines starting exactly there, so nothing is duplicated or lost at the seam).
 */
export function appendLines(
  current: readonly TranscriptLine[],
  fresh: readonly TranscriptLine[],
  fromMs: number,
): TranscriptLine[] {
  const ids = new Set(fresh.map((l) => l.id));
  return [...current.filter((l) => l.startMs < fromMs && !ids.has(l.id)), ...fresh];
}

/** A user-facing message for a failed participant change. */
export function participantError(error: unknown): Error {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return new Error('You can’t edit this note.', { cause: error });
    if (error.status === 404) return new Error('This note or attendee is gone.', { cause: error });
    return new Error(error.message, { cause: error });
  }
  return new Error('Something went wrong.', { cause: error });
}
