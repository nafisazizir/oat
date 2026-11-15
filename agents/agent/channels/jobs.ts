/**
 * Server-to-server job routes (no conversation, no model): the web app hands over a post-meeting run here and
 * can read it back.
 *
 *   POST /jobs/post-meeting              { pipelineRunId, attempt, meetingId, workspaceId, pushDelayMs? }
 *                                        → 202 { runId } (the same runId again for a repeat of the attempt)
 *   GET  /jobs/post-meeting/runs/:runId  → { runId, status, result }   (the Workflow world's record)
 *   GET  /jobs/post-meeting/:meetingId   → { run }                     (the meeting's `pipeline_run` row)
 *
 * D-29 contract: the web app authorises the user against the meeting (`@oat/core`, owner/editor) *before*
 * calling and names the workspace it checked; a meeting whose note isn't in that workspace — or a run/attempt
 * that doesn't match the `pipeline_run` row — is a 404/409 here (and fails the run if the note moves later).
 * Auth: `Authorization: Bearer <token>` matching `OAT_AGENTS_TOKEN` or, while rotating, `OAT_AGENTS_TOKEN_PREVIOUS`
 * (each ≥ 32 characters; no valid token configured → 503). The server binds to 127.0.0.1 (`src/cli/serve.ts`);
 * it is never public. It also refuses to start runs without its own Workflow database (503), since the world
 * would otherwise write into the app database.
 */
import { timingSafeEqual } from 'node:crypto';

import { pipelineRun } from '@oat/db';
import { toPipelineRunDto } from '@oat/services/pipeline';
import { eq } from 'drizzle-orm';
import { defineChannel, GET, POST } from 'eve/channels';
import { getRun } from 'eve/workflow/api';
import { z } from 'zod';

import { agentsConfig, workflowDatabaseProblem } from '../../src/env.ts';
import { stepContext } from '../../src/post-meeting/context.ts';
import { startPostMeetingJob } from '../lib/start-job.ts';

const Id = z.string().min(1).max(64);
const StartBody = z.object({
  pipelineRunId: Id,
  attempt: z.number().int().min(1),
  meetingId: Id,
  workspaceId: Id,
  pushDelayMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .optional(),
});

/** `null` when the caller may proceed, else the response to send. */
function deny(request: Request): Response | null {
  const tokens = agentsConfig().jobsTokens;
  if (tokens.length === 0) return Response.json({ error: 'not_configured' }, { status: 503 });
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  // Compare against every accepted token (no early exit), each in constant time.
  let ok = false;
  for (const token of tokens) {
    const expected = Buffer.from(`Bearer ${token}`);
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok ? null : Response.json({ error: 'unauthorized' }, { status: 401 });
}

export default defineChannel({
  routes: [
    POST('/jobs/post-meeting', async (request) => {
      const denied = deny(request);
      if (denied) return denied;
      const problem = workflowDatabaseProblem();
      if (problem)
        return Response.json({ error: 'not_configured', detail: problem }, { status: 503 });
      const body = StartBody.safeParse(await request.json().catch(() => null));
      if (!body.success) return Response.json({ error: 'bad_request' }, { status: 400 });
      const result = await startPostMeetingJob(body.data);
      if (!('workflowRunId' in result)) {
        return Response.json(
          { error: result.status },
          { status: result.status === 'not_found' ? 404 : 409 },
        );
      }
      return Response.json({ runId: result.workflowRunId }, { status: 202 });
    }),
    GET('/jobs/post-meeting/runs/:runId', async (request, { params }) => {
      const denied = deny(request);
      if (denied) return denied;
      try {
        const run = getRun(params.runId ?? '');
        const status = await run.status;
        const result = status === 'completed' ? await run.returnValue : null;
        return Response.json({ runId: params.runId, status, result });
      } catch {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
    }),
    GET('/jobs/post-meeting/:meetingId', async (request, { params }) => {
      const denied = deny(request);
      if (denied) return denied;
      const [row] = await stepContext()
        .db.select()
        .from(pipelineRun)
        .where(eq(pipelineRun.meetingId, params.meetingId ?? ''));
      return Response.json({ run: row ? toPipelineRunDto(row) : null });
    }),
  ],
});
