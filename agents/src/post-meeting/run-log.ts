/**
 * (4) The run log. The full record of every run (inputs, each step's result, retries, timings) is the
 * Workflow world's own (`getRun(runId)`, Postgres world in dev/self-host, Vercel Workflow in prod). This adds
 * the per-meeting view the product needs ("what did the pipeline do for this meeting?"): the last runs of a
 * meeting, newest first, in Redis.
 *
 * Spike limitation: Redis is not where product data lives. 8.3 adds an `agent_run` table (synced, so the
 * meeting view can show it) and writes it from this step instead.
 */
import type { StepContext } from './context.ts';
import type { PostMeetingRun } from './types.ts';

/** Runs kept per meeting. */
export const RUN_LOG_KEEP = 20;
/** Kept this long after the last run. */
export const RUN_LOG_TTL_SECONDS = 30 * 24 * 60 * 60;

export const runLogKey = (prefix: string, meetingId: string) =>
  `${prefix}:post-meeting:${meetingId}:runs`;

/** Idempotent per run id: a replayed step replaces the entry it wrote instead of adding a second one. */
export async function recordRun(ctx: StepContext, run: PostMeetingRun): Promise<void> {
  const redis = await ctx.redis();
  const key = runLogKey(ctx.config.runLogPrefix, run.meetingId);
  const entries = await redis.lRange(key, 0, -1);
  const kept = entries.filter((e) => (JSON.parse(e) as PostMeetingRun).runId !== run.runId);
  await redis
    .multi()
    .del(key)
    .rPush(key, [JSON.stringify(run), ...kept].slice(0, RUN_LOG_KEEP))
    .expire(key, RUN_LOG_TTL_SECONDS)
    .exec();
}

export async function readRunLog(ctx: StepContext, meetingId: string): Promise<PostMeetingRun[]> {
  const redis = await ctx.redis();
  const entries = await redis.lRange(runLogKey(ctx.config.runLogPrefix, meetingId), 0, -1);
  return entries.map((e) => JSON.parse(e) as PostMeetingRun);
}
