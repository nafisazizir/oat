import 'server-only';

import { z } from 'zod';

/**
 * Typed server environment (D-11 variables, documented in `.env.example`).
 *
 * The repo-root `.env` is loaded by `next.config.ts`. Every value here has a counterpart in
 * `.env.example`, so the app boots against the local compose stack with nothing but those defaults.
 * Blank provider keys mean "use the local mock" (DEV.md, "Switching a provider to the real thing").
 *
 * Server-only (enforced by the `server-only` import): a client import fails the build.
 */

/** Empty strings (`KEY=` in `.env`) count as unset. */
const optional = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const url = z.url();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: url,
  REDIS_URL: url,

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: z.string().min(1),
  MAILPIT_URL: url.optional(),

  OAUTH_GOOGLE_ISSUER: url,
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1),

  MOCKS_URL: url,
  AI_GATEWAY_API_KEY: optional,
  AI_GATEWAY_BASE_URL: optional.pipe(url.optional()),
  DEEPGRAM_API_KEY: optional,
  DEEPGRAM_BASE_URL: optional.pipe(url.optional()),
});

export type ServerEnv = z.infer<typeof envSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

/** Validates an env record. Throws an `EnvError` naming every bad variable (never their values). */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
  );
  throw new EnvError(
    `Invalid environment. Copy .env.example to .env (pnpm dev:up does this) and fix:\n${problems.join('\n')}`,
  );
}

let cached: ServerEnv | undefined;

/** The validated server env, parsed once on first use (not at import, so `next build` needs no `.env`). */
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Which integrations talk to a real provider vs the local mock (key set → real). */
export function integrationModes(env: ServerEnv) {
  return {
    ai: env.AI_GATEWAY_API_KEY ? 'real' : 'mock',
    stt: env.DEEPGRAM_API_KEY ? 'real' : 'mock',
    oauth: new URL(env.OAUTH_GOOGLE_ISSUER).hostname === 'accounts.google.com' ? 'real' : 'mock',
  } as const;
}
