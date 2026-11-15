/**
 * The backstop sweeps (8.3), every minute:
 * 1. hand over post-meeting runs that are still `waiting` because this server was down (or unreachable) when the
 *    web app asked — same claim + dedupe as every other hand-over (`@oat/services/pipeline`), so it is safe next
 *    to the web app's own re-dispatch and on several replicas;
 * 2. settle runs that look live but haven't moved for 10 min, from the Workflow world's record of their run
 *    (lost / failed / cancelled → failed and retryable; completed → completed; still running → left alone).
 * Fires under `eve start` (`agent:start`, the compose `agents` service); `eve dev` never fires schedules, so in
 * `pnpm dev` the meeting header's status read re-dispatches instead (or POST the dev dispatch route).
 */
import { recoverStuckRuns, sweepPipelineRuns, type WorkflowRunState } from '@oat/services/pipeline';
import { defineSchedule } from 'eve/schedules';
import { getRun } from 'eve/workflow/api';

import { agentsConfig } from '../../src/env.ts';
import { stepContext } from '../../src/post-meeting/context.ts';
import { inProcessDispatcher } from '../lib/start-job.ts';

const STATES = new Set<WorkflowRunState>([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/** The world's view of a run; `missing` when it doesn't know it (wiped world, run expired). */
async function workflowState(workflowRunId: string): Promise<WorkflowRunState> {
  try {
    const status = String(await getRun(workflowRunId).status);
    return STATES.has(status as WorkflowRunState) ? (status as WorkflowRunState) : 'running';
  } catch (error) {
    const e = error as Error;
    if (e?.name === 'WorkflowRunNotFoundError' || /not found|expired/i.test(e?.message ?? '')) {
      return 'missing';
    }
    throw error;
  }
}

async function sweep(): Promise<void> {
  const log = (message: string, error: unknown) =>
    console.error(`[post-meeting sweep] ${message}`, error);
  const { db } = stepContext();
  const handed = await sweepPipelineRuns({ db, dispatcher: inProcessDispatcher, logError: log });
  if (handed.dispatched || handed.waiting) {
    console.log(
      `[post-meeting sweep] handed over ${handed.dispatched}, still waiting ${handed.waiting}`,
    );
  }
  const stuck = await recoverStuckRuns(db, workflowState, {
    olderThanMs: agentsConfig().stuckAfterMs,
  });
  if (stuck.failed || stuck.completed || stuck.requeued) {
    console.log(`[post-meeting sweep] settled stuck runs ${JSON.stringify(stuck)}`);
  }
}

export default defineSchedule({
  cron: '* * * * *',
  run({ waitUntil }) {
    waitUntil(
      sweep().catch((error: unknown) => console.error('[post-meeting sweep] failed', error)),
    );
  },
});
