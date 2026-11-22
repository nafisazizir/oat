export type { MeetingParticipant } from '@oat/core';
import type { MeetingParticipant } from '@oat/core';

export type TranscriptLine = {
  id: string;
  /** `mic` = me, `system` = the others on the call. */
  source: 'mic' | 'system';
  speaker: string;
  startMs: number;
  text: string;
};

export type MeetingInfo = {
  /** `null`: a meeting note that was never recorded and has no attendees yet. */
  meetingId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  recording?: { calendarEventId: string | null; lastSegmentEndMs?: number };
  participants: MeetingParticipant[];
  /** Only with `?transcript=1`. */
  transcript?: TranscriptLine[];
};

export type AddParticipantInput = { name: string; email: string | null };

export type MeetingQuery = { transcript?: boolean; after?: number; recording?: boolean };
