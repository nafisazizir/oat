/** Shapes shared by the post-meeting workflow (agent/lib), its steps (src) and the jobs route. All JSON. */
import type { PipelineStepName, PipelineStepRecord } from '@oat/services/dto/pipeline';
import type { PostMeetingJob } from '@oat/services/pipeline';

export interface PostMeetingInput extends PostMeetingJob {
  /**
   * Durable wait before the Notion push (`sleep` in the workflow: holds no compute, survives restarts). Not set
   * by the web app today; the int test uses it to kill the server mid-run.
   */
  pushDelayMs?: number;
}

/** What the steps need to know about the meeting, read once at the start of a run. */
export interface MeetingRef {
  meetingId: string;
  documentId: string;
  workspaceId: string;
  /** The note's owner: the pipeline acts as this user (their permissions, settings and Notion connection). */
  ownerId: string;
  /** The meeting's end when the run started (ISO); an enhancement from before it doesn't count as done. */
  endedAt: string | null;
}

export type StepName = PipelineStepName;
export type StepRecord = PipelineStepRecord;

/** The workflow's return value (also recorded on `pipeline_run`). */
export interface PostMeetingRun {
  runId: string;
  pipelineRunId: string;
  attempt: number;
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
 * The meeting is gone, never existed, isn't in the workspace the caller named, or this attempt was superseded:
 * retrying can't help. Becomes `FatalError` in the workflow.
 */
export class MeetingNotFound extends Error {
  override name = 'MeetingNotFound';
}

/**
 * The note's owner (whom the pipeline acts as) can no longer edit the note: no attempt can succeed until that
 * changes, so the run fails without the step's retries and without offering Retry (`owner_no_access`).
 */
export class OwnerNoAccess extends Error {
  override name = 'OwnerNoAccess';
}
