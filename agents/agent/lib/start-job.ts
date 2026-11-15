/**
 * Starting the post-meeting workflow for one `pipeline_run` attempt, shared by the jobs route (the web app
 * hands a job over) and the backstop sweep (`schedules/post-meeting-sweep.ts`, which hands over runs that
 * waited while this server was down). Once per attempt: repeats get the Workflow run the first call started.
 */
import {
  DispatchError,
  type PipelineDispatcher,
  type PostMeetingJob,
  startPipelineWorkflow,
} from '@oat/services/pipeline';
import { start } from 'eve/workflow/api';

import { stepContext } from '../../src/post-meeting/context.ts';
import { loadMeeting } from '../../src/post-meeting/steps.ts';
import { MeetingNotFound, type PostMeetingInput } from '../../src/post-meeting/types.ts';
import { postMeetingWorkflow } from './post-meeting.ts';

export type StartJobResult =
  | { status: 'started' | 'existing'; workflowRunId: string }
  | { status: 'not_found' | 'superseded' };

export async function startPostMeetingJob(input: PostMeetingInput): Promise<StartJobResult> {
  const ctx = stepContext();
  try {
    // D-29: the meeting's note must be in the workspace the web app authorised the user against.
    // Ids only: an owner who lost access is the workflow's to report (a clear, final failure on the run).
    await loadMeeting(ctx, input.meetingId, input.workspaceId, { checkOwner: false });
  } catch (error) {
    if (error instanceof MeetingNotFound) return { status: 'not_found' };
    throw error;
  }
  return startPipelineWorkflow(ctx.db, input, async () => {
    const run = await start(postMeetingWorkflow, [input]);
    return run.runId;
  });
}

/** The sweep's dispatcher: no HTTP hop, same rules as the jobs route. */
export const inProcessDispatcher: PipelineDispatcher = {
  async dispatch(job: PostMeetingJob) {
    const result = await startPostMeetingJob(job);
    if (result.status === 'started' || result.status === 'existing') {
      return { workflowRunId: result.workflowRunId };
    }
    throw new DispatchError(`job ${result.status}`, true);
  },
};
