/**
 * Model registry: which AI Gateway model serves each role (SPEC §5, D-3). Ids are `provider/model` strings
 * from the AI Gateway catalog (`GET https://ai-gateway.vercel.sh/v1/models`, checked 2026-11-14). Override one
 * per environment with `AI_MODEL_<ROLE>` (e.g. `AI_MODEL_FAST=anthropic/claude-haiku-4.5`) — no code change.
 * The mock LLM accepts any id, so the same ids flow through in dev and show up in its request log.
 */

export const AI_ROLES = ['enhance', 'chat', 'fast', 'judge', 'embed'] as const;
/**
 * `enhance`: note enhancement · `chat`: assistants/Q&A · `fast`: titles, classification · `judge`: eval grader
 * (quality tier, `pnpm --filter @oat/ai eval --model real`) · `embed`: retrieval.
 */
export type AiRole = (typeof AI_ROLES)[number];
export type LanguageRole = Exclude<AiRole, 'embed'>;

export const DEFAULT_MODELS: Readonly<Record<AiRole, string>> = {
  enhance: 'anthropic/claude-sonnet-5.5',
  chat: 'anthropic/claude-sonnet-5.5',
  fast: 'anthropic/claude-haiku-5.5',
  // Deliberately another provider's model than `enhance`/`chat`, so evals aren't graded by the model under test.
  judge: 'openai/gpt-5.5',
  // 1536-dimensional natively, matching EMBEDDING_DIMENSIONS.
  embed: 'openai/text-embedding-3-small',
};

/**
 * Width of every stored embedding, defined in `@oat/core` (zero-dep) so `@oat/db` can size `chunk.embedding`
 * without depending on `@oat/ai`. Changing it needs a migration and a re-embed. An `AI_MODEL_EMBED` override
 * must produce vectors of this size.
 */
export { EMBEDDING_DIMENSIONS } from '@oat/core';

/** Environment as read by `@oat/ai` (a subset of `process.env`). */
export type AiEnv = Readonly<Record<string, string | undefined>>;

/** `provider/model`, e.g. `anthropic/claude-sonnet-5.5`. */
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

export function isAiRole(value: unknown): value is AiRole {
  return typeof value === 'string' && (AI_ROLES as readonly string[]).includes(value);
}

export function modelEnvVar(role: AiRole): string {
  return `AI_MODEL_${role.toUpperCase()}`;
}

/** Model id for `role`: `AI_MODEL_<ROLE>` when set (non-blank), else the default. */
export function resolveModelId(role: AiRole, env: AiEnv = {}): string {
  if (!isAiRole(role))
    throw new Error(`unknown AI role "${String(role)}" (expected ${AI_ROLES.join('|')})`);
  const name = modelEnvVar(role);
  const override = env[name]?.trim();
  if (!override) return DEFAULT_MODELS[role];
  if (!MODEL_ID.test(override)) {
    throw new Error(
      `${name}="${override}" is not a "provider/model" id (see the AI Gateway model list)`,
    );
  }
  return override;
}

/** The full role → model id map for `env`. */
export function resolveModels(env: AiEnv = {}): Record<AiRole, string> {
  return Object.fromEntries(AI_ROLES.map((role) => [role, resolveModelId(role, env)])) as Record<
    AiRole,
    string
  >;
}
