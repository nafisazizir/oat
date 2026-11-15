/**
 * Audio retention policy math (task 3.8, D-10): which meetings' audio a policy deletes. Pure, so the sweeper
 * and the UI's dry run ("would free 1.2 GB") share it and it is unit-tested without files.
 *
 * Units: a meeting (all of its parts and sources) is deleted or kept as a whole. Safety, whatever the
 * policy: a meeting being recorded, or with any audio activity in the last hour, is never selected
 * (`protected`); it still counts towards the total for the size cap.
 */
import type { RetentionPolicy } from '@oat/core/bridge';

/** Files younger than this are never deleted by the sweeper. */
export const MIN_AUDIO_AGE_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Decimal gigabytes, like Finder. */
export const GB = 1_000_000_000;

export interface MeetingUsage {
  readonly meetingId: string;
  readonly bytes: number;
  /** First recording session (Unix ms): "oldest first" order for the size cap. */
  readonly startedAt: number;
  /** Latest audio activity (Unix ms): what the age policy and the 1-hour guard look at. */
  readonly lastActivityAt: number;
  /** Being recorded (or its files are still closing). */
  readonly active: boolean;
}

export interface RetentionPlan {
  /** Meetings to delete, oldest first. */
  readonly meetingIds: string[];
  readonly bytes: number;
  /** For the size cap: still over it after deleting everything allowed. */
  readonly overCapAfter: boolean;
}

/** Never touched by the sweeper: the active recording, or audio from the last hour (or the future). */
export function isProtected(meeting: MeetingUsage, now: number): boolean {
  return meeting.active || now - meeting.lastActivityAt < MIN_AUDIO_AGE_MS;
}

const oldestFirst = (a: MeetingUsage, b: MeetingUsage) =>
  a.startedAt - b.startedAt ||
  a.lastActivityAt - b.lastActivityAt ||
  (a.meetingId < b.meetingId ? -1 : a.meetingId > b.meetingId ? 1 : 0);

export function planRetention(
  meetings: readonly MeetingUsage[],
  policy: RetentionPolicy,
  now: number,
): RetentionPlan {
  const candidates = meetings.filter((m) => !isProtected(m, now)).sort(oldestFirst);
  switch (policy.kind) {
    case 'forever':
      return { meetingIds: [], bytes: 0, overCapAfter: false };
    case 'age': {
      const cutoff = now - policy.days * DAY_MS;
      const chosen = candidates.filter((m) => m.lastActivityAt <= cutoff);
      return {
        meetingIds: chosen.map((m) => m.meetingId),
        bytes: sum(chosen),
        overCapAfter: false,
      };
    }
    case 'size': {
      const cap = Math.floor(policy.gb * GB);
      let total = sum(meetings);
      const chosen: MeetingUsage[] = [];
      for (const m of candidates) {
        if (total <= cap) break;
        if (m.bytes <= 0) continue; // frees nothing
        chosen.push(m);
        total -= m.bytes;
      }
      return {
        meetingIds: chosen.map((m) => m.meetingId),
        bytes: sum(chosen),
        overCapAfter: total > cap,
      };
    }
  }
}

function sum(meetings: readonly MeetingUsage[]): number {
  return meetings.reduce((n, m) => n + Math.max(0, m.bytes), 0);
}
