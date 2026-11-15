/**
 * The post-meeting pipeline (8.3, D-29): our own run log and the per-user switches. Server-only (not synced, no
 * change_log trigger): the web app reads it for the meeting header, the background agents write it.
 */
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { id, timestamps, timestamptz } from './columns.ts';
import { document } from './documents.ts';
import { pipelineRunStatusEnum } from './enums.ts';
import { meeting } from './meetings.ts';
import { workspace } from './workspace.ts';

/** One step's result as the agents record it (`@oat/services/pipeline` has the full type). */
export type PipelineStepJson = {
  step: string;
  outcome: 'ran' | 'skipped';
  reason?: string;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
};

/**
 * One post-meeting run per meeting (unique `meeting_id`): asking again returns this row (idempotent), a retry
 * bumps `attempt` on it. Lifecycle (`status`):
 *
 *   waiting ─(agents accepted the job)→ queued ─(first step)→ running ─→ completed | failed
 *      ↑ agents unreachable: `next_dispatch_at` says when the backstop sweep tries again
 *   failed ─(retry)→ waiting …
 *
 * The agents' writes are fenced on `attempt`, so a superseded workflow run can't overwrite a retry's state.
 */
export const pipelineRun = pgTable(
  'pipeline_run',
  {
    id: id(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meeting.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'cascade' }),
    /** The workspace the requester was authorised against (D-29 `/jobs` contract). */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** Who asked: the user who ended the meeting, or who pressed retry. */
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    status: pipelineRunStatusEnum('status').notNull().default('waiting'),
    /** 1, then +1 per retry. */
    attempt: integer('attempt').notNull().default(1),
    /** The step the current attempt is on (`enhance` | `index` | `notion`); null when not running. */
    currentStep: text('current_step'),
    /** The current attempt's finished steps, in order. */
    steps: jsonb('steps').$type<PipelineStepJson[]>().notNull().default([]),
    /** Why the attempt failed (user-facing). */
    error: text('error'),
    /**
     * Why, as a code, when a retry can't help (`owner_no_access`: the note's owner lost access to it); null
     * otherwise. The header offers no Retry then.
     */
    errorCode: text('error_code'),
    /**
     * The meeting end (`meeting.ended_at`) this run was asked for. A later end (the meeting was resumed and ended
     * again, D-24) runs the pipeline again: a finished run is re-armed as the next attempt, a live one is flagged
     * (`rerun_requested`) and re-armed when it finishes.
     */
    endedAt: timestamptz('ended_at'),
    rerunRequested: boolean('rerun_requested').notNull().default(false),
    /** The Workflow run of the current attempt (eve `start()`), once the agents accepted it. */
    workflowRunId: text('workflow_run_id'),
    /** Failed hand-overs to the agents server for this attempt, the last error, and when to try again. */
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    dispatchError: text('dispatch_error'),
    nextDispatchAt: timestamptz('next_dispatch_at'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('pipeline_run_meeting_uq').on(t.meetingId),
    index('pipeline_run_document_idx').on(t.documentId),
    // The backstop sweep: waiting runs that are due.
    index('pipeline_run_due_idx').on(t.status, t.nextDispatchAt),
  ],
);

/**
 * A user's post-meeting switches per workspace (8.3). No row = the defaults. Notion auto-send lives on the Notion
 * connection itself (`integration.settings_json.autoPush`), since it means nothing without one.
 */
export const pipelineSetting = pgTable(
  'pipeline_setting',
  {
    id: id(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Enhance the notes when a meeting ends (template: the meeting's, else the default). On by default. */
    autoEnhance: boolean('auto_enhance').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('pipeline_setting_workspace_user_uq').on(t.workspaceId, t.userId)],
);
