/** Shapes shared by the post-meeting workflow (agent/lib), its steps (src) and the jobs route. All JSON. */

export interface PostMeetingInput {
  meetingId: string;
  /**
   * The workspace the caller (the web app) authorised the user against (D-29). The run fails if the meeting's
   * note is not in it: defence in depth against a caller passing someone else's meeting id.
   */
  workspaceId: string;
  /**
   * Durable wait before the Notion push (`sleep` in the workflow: holds no compute, survives restarts). A
   * product knob for 8.3 ("give the user a few minutes to fix the notes before auto-push"); the int test uses it
   * to kill the server mid-run.
   */
  pushDelayMs?: number;
}

/** What the steps need to know about the meeting, read once at the start of a run. */
export interface MeetingRef {
  meetingId: string;
  documentId: string;
  workspaceId: string;
  /** The note's owner: the pipeline acts as this user (their permissions, their Notion connection). */
  ownerId: string;
}

export type StepName = 'enhance' | 'index' | 'notion';

export interface StepRecord {
  step: StepName;
  /** `ran`: did work. `skipped`: nothing to do or not configured (`reason`). */
  outcome: 'ran' | 'skipped';
  reason?: string;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
}

export interface PostMeetingRun {
  runId: string;
  meetingId: string;
  documentId: string | null;
  status: 'completed' | 'failed';
  startedAt: string;
  finishedAt: string;
  steps: StepRecord[];
  error?: string;
}

/**
 * Returned by a step function when the work can't be done *yet* (a live enhancement of the note is running
 * elsewhere, a Notion push holds the lease). The workflow then waits with a durable `sleep` and calls the step
 * again, up to a deadline. Not an error on purpose: errors spend the step's retry budget (3 retries in the
 * Workflow SDK), which a crashed enhancement (stale only after 3 min, D-26) would exhaust.
 */
export interface Busy {
  busy: string;
}

/** A step's answer as the workflow sees it: done, or busy with the wait policy from config. */
export type StepOutcome =
  | StepRecord
  | (Busy & {
      retryAfterMs: number;
      deadlineMs: number;
      /** When the step answered (ms). */ at: number;
    });

export const isBusy = (r: StepRecord | Busy): r is Busy => 'busy' in r;

/**
 * The meeting is gone, never existed, or isn't in the workspace the caller named: retrying can't help.
 * Becomes `FatalError` in the workflow.
 */
export class MeetingNotFound extends Error {
  override name = 'MeetingNotFound';
}
