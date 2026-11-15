import { getModel } from '@oat/ai/provider';
import { defineAgent } from 'eve';
import { defineDynamic } from 'eve/models';

/*
 * Oat's background agent (8.2 spike). Today it hosts one deterministic durable workflow, the post-meeting
 * pipeline (`lib/post-meeting.ts`, started by `channels/jobs.ts` without any model call); model-driven
 * sessions (digests, a Slack channel) can be added here later.
 *
 * - Model: the same role-based selection as the web app (`@oat/ai`: AI Gateway with a key/OIDC, else the
 *   OpenAI-compatible mock LLM, D-11/D-13). Resolved per call so `eve build` needs no AI env.
 * - Durability: the Postgres Workflow world (`@workflow/world-postgres`, Graphile Worker queue) on the compose
 *   Postgres, in a database of its own (`WORKFLOW_POSTGRES_URL`, see src/env.ts); Vercel Workflow on Vercel.
 * - No default tools: no sandbox, shell or file tools until an agent needs them.
 */
export default defineAgent({
  // A selection object: dynamic agents set the context window here (the mock isn't in the Gateway catalog).
  model: defineDynamic(() => ({ model: getModel('fast'), modelContextWindowTokens: 200_000 })),
  defaultTools: false,
  experimental: {
    workflow: { world: '@workflow/world-postgres' },
  },
});
