/**
 * The meeting side of a `meeting` note on the web (3.4): when it was recorded, who was there, and (on
 * request) its transcript. Shapes of `src/server/meeting.ts` + a small browser client.
 *
 *   GET    /api/documents/:id/meeting[?transcript=1[&after=<ms>]]  MeetingInfo (readers)
 *   POST   /api/documents/:id/participants  { name, email? }  → 201 MeetingParticipant (editors)
 *   DELETE /api/documents/:id/participants/:participantId     → 204 (editors)
 *   GET    /api/documents/:id/calendar-event                 NoteEventCandidatesDto (editors)
 *   PUT    /api/documents/:id/calendar-event  { eventId }    LinkEventResult (editors)
 *   DELETE /api/documents/:id/calendar-event                 → 204 (editors)
 */
import type { LinkEventResult, NoteEventCandidatesDto } from '@oat/services/dto/calendar';
import type {
  MeetingParticipant,
  MeetingInfo,
  AddParticipantInput,
} from '@oat/services/dto/meeting';

import { ApiRequestError, request } from './api-client';
import type { TranscriptLine } from './transcript';

export type {
  MeetingParticipant,
  MeetingInfo,
  AddParticipantInput,
} from '@oat/services/dto/meeting';

const enc = encodeURIComponent;

export const meetingApi = {
  /** `after`: only transcript lines starting at or after it (ms). */
  get: (
    documentId: string,
    opts: { transcript?: boolean; after?: number; recording?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    if (opts.transcript) {
      query.set('transcript', '1');
      if (opts.after) query.set('after', String(Math.floor(opts.after)));
    }
    if (opts.recording) query.set('recording', '1');
    return request<MeetingInfo>(
      'GET',
      `/api/documents/${enc(documentId)}/meeting${query.size ? `?${query}` : ''}`,
    );
  },
  addParticipant: (documentId: string, input: AddParticipantInput) =>
    request<MeetingParticipant>('POST', `/api/documents/${enc(documentId)}/participants`, input),
  removeParticipant: (documentId: string, participantId: string) =>
    request<void>('DELETE', `/api/documents/${enc(documentId)}/participants/${enc(participantId)}`),
  /** The calendar events around the note's time, and which one it is linked to. */
  eventChoices: (documentId: string) =>
    request<NoteEventCandidatesDto>('GET', `/api/documents/${enc(documentId)}/calendar-event`),
  linkEvent: (documentId: string, eventId: string) =>
    request<LinkEventResult>('PUT', `/api/documents/${enc(documentId)}/calendar-event`, {
      eventId,
    }),
  unlinkEvent: (documentId: string) =>
    request<void>('DELETE', `/api/documents/${enc(documentId)}/calendar-event`),
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

/** A user-facing message for a failed calendar-event link change. */
export function eventLinkError(error: unknown): Error {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return new Error('You can’t edit this note.', { cause: error });
    if (error.status === 404)
      return new Error('That event isn’t in your calendar anymore.', { cause: error });
    return new Error(error.message, { cause: error });
  }
  return new Error('Something went wrong.', { cause: error });
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
