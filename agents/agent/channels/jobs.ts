/**
 * Server-to-server job routes (no conversation, no model): the web app (8.3: on meeting end) starts the
 * post-meeting workflow here and can read a run back.
 *
 *   POST /jobs/post-meeting              { meetingId, workspaceId, pushDelayMs? } → 202 { runId }
 *   GET  /jobs/post-meeting/runs/:runId  → { runId, status, result }   (the Workflow world's record)
 *   GET  /jobs/post-meeting/:meetingId   → { runs }                    (the per-meeting run log, newest first)
 *
 * D-29 contract: the web app authorises the user against the meeting (`@oat/core`) *before* calling, and names
 * the workspace it checked; a meeting whose note isn't in that workspace is a 404 here (and fails the run if it
 * moved meanwhile). Auth: `Authorization: Bearer <token>` matching `OAT_AGENTS_TOKEN` or, while rotating,
 * `OAT_AGENTS_TOKEN_PREVIOUS` (each ≥ 32 characters; no valid token configured → 503). The server binds to
 * 127.0.0.1 (`src/cli/serve.ts`); it is never public. It also refuses to start runs without its own Workflow
 * database (503), since the world would otherwise write into the app database.
 */
import { timingSafeEqual } from 'node:crypto';

import { defineChannel, GET, POST } from 'eve/channels';
import { getRun, start } from 'eve/workflow/api';
import { z } from 'zod';

import { agentsConfig, workflowDatabaseProblem } from '../../src/env.ts';
import { stepContext } from '../../src/post-meeting/context.ts';
import { readRunLog } from '../../src/post-meeting/run-log.ts';
import { loadMeeting } from '../../src/post-meeting/steps.ts';
import { MeetingNotFound } from '../../src/post-meeting/types.ts';
import { postMeetingWorkflow } from '../lib/post-meeting.ts';

const Id = z.string().min(1).max(64);
const StartBody = z.object({
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
      try {
        await loadMeeting(stepContext(), body.data.meetingId, body.data.workspaceId);
      } catch (error) {
        if (error instanceof MeetingNotFound) {
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
        throw error;
      }
      const run = await start(postMeetingWorkflow, [body.data]);
      return Response.json({ runId: run.runId }, { status: 202 });
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
      return Response.json({ runs: await readRunLog(stepContext(), params.meetingId ?? '') });
    }),
  ],
});
