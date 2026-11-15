import 'server-only';

import { isRealGoogleCalendar, resolveGoogleCalendarBaseUrl } from '@oat/calendar/google';
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

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: url,
    REDIS_URL: url,

    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: url,
    BETTER_AUTH_TRUSTED_ORIGINS: optional,
    AUTH_MAX_TEAM_WORKSPACES: optional.pipe(z.string().regex(/^\d+$/).optional()),

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
    /** Google Calendar API origin (blank: Google with a real issuer, else ${MOCKS_URL}/gcal). */
    GOOGLE_CALENDAR_BASE_URL: optional.pipe(url.optional()),

    /**
     * Desktop sign-in (1.8): the "copy the link for the app" fallback on `/desktop/sign-in`, for dev builds
     * whose Electron binary isn't the registered `oat://` handler. On by default outside production,
     * `0` turns it off; never in production (setting `1` there is refused).
     */
    OAT_DESKTOP_DEV_HANDOFF: optional.pipe(z.enum(['0', '1']).optional()),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.OAT_DESKTOP_DEV_HANDOFF === '1') {
      ctx.addIssue({
        code: 'custom',
        path: ['OAT_DESKTOP_DEV_HANDOFF'],
        message: 'must not be enabled in production (a copyable sign-in code invites phishing)',
      });
    }
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

/**
 * Whether `/desktop/sign-in` offers the copy-link fallback. Never in production: a sign-in code someone
 * can be talked into copying and pasting elsewhere is an account-takeover path (1.8 security review).
 */
export function desktopDevHandoff(env: Pick<ServerEnv, 'NODE_ENV' | 'OAT_DESKTOP_DEV_HANDOFF'>) {
  return env.NODE_ENV !== 'production' && env.OAT_DESKTOP_DEV_HANDOFF !== '0';
}

/** Which integrations talk to a real provider vs the local mock (key set → real). */
export function integrationModes(env: ServerEnv) {
  return {
    ai: env.AI_GATEWAY_API_KEY ? 'real' : 'mock',
    stt: env.DEEPGRAM_API_KEY ? 'real' : 'mock',
    oauth: new URL(env.OAUTH_GOOGLE_ISSUER).hostname === 'accounts.google.com' ? 'real' : 'mock',
    calendar: isRealGoogleCalendar(googleCalendarBaseUrl(env)) ? 'real' : 'mock',
  } as const;
}

/** Google Calendar API base URL (`@oat/calendar/google` rules: explicit, real Google, else the mock). */
export function googleCalendarBaseUrl(env: ServerEnv): string {
  return resolveGoogleCalendarBaseUrl({
    GOOGLE_CALENDAR_BASE_URL: env.GOOGLE_CALENDAR_BASE_URL,
    OAUTH_GOOGLE_ISSUER: env.OAUTH_GOOGLE_ISSUER,
    MOCKS_URL: env.MOCKS_URL,
  });
}
