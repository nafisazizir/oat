/**
 * Auth configuration from the environment (D-11: `.env.example` defaults point at the compose stack).
 * Real providers switch on with env only: a real `OAUTH_GOOGLE_ISSUER` + client id/secret, a real SMTP
 * host + credentials, a long random `BETTER_AUTH_SECRET` and the public `BETTER_AUTH_URL`.
 */
import { z } from 'zod';

/** The dev secret committed in `.env.example`. Refused for a public production deployment. */
export const DEV_AUTH_SECRET = 'oat-dev-secret-not-for-production-0123456789';

/**
 * Default cap on workspaces one user can create themselves (`AUTH_MAX_TEAM_WORKSPACES`), on top of the one
 * made for them at sign-up.
 */
export const DEFAULT_MAX_TEAM_WORKSPACES = 20;

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** RFC 5322 From, e.g. `Oat <no-reply@oat.localhost>`. */
  from: string;
}

export interface OidcProviderConfig {
  /** OIDC issuer; discovery is `${issuer}/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  /** Signs cookies and tokens. ≥ 32 characters. */
  secret: string;
  /** Public origin of the web app (where `/api/auth/*` is served), e.g. `http://localhost:3000`. */
  baseURL: string;
  /** Extra origins allowed to call the auth API (the base URL is always trusted). */
  trustedOrigins: string[];
  smtp: SmtpConfig;
  google: OidcProviderConfig;
  /** Redis for the per-email magic-link limit (`REDIS_URL`); in-memory when unset. */
  redisUrl?: string;
  /** Team workspaces one user may create. */
  maxTeamWorkspaces: number;
  production: boolean;
}

const blankToUndefined = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const schema = z.object({
  NODE_ENV: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_TRUSTED_ORIGINS: blankToUndefined,
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: blankToUndefined,
  SMTP_PASSWORD: blankToUndefined,
  SMTP_FROM: z.string().min(1),
  OAUTH_GOOGLE_ISSUER: z.url(),
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1),
  REDIS_URL: blankToUndefined.pipe(z.url().optional()),
  AUTH_MAX_TEAM_WORKSPACES: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .pipe(z.number().int().min(0).optional()),
});

export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

const stripSlash = (url: string) => url.replace(/\/+$/, '');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for `localhost`/`127.0.0.1`/`[::1]` (the compose `web` container runs production locally). */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK.has(new URL(url).hostname);
}

/** Parses auth config from env. Errors name the variables, never their values. */
export function authConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new AuthConfigError(
      `Invalid auth environment (see .env.example):\n${problems.join('\n')}`,
    );
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const baseURL = stripSlash(e.BETTER_AUTH_URL);
  const issuer = stripSlash(e.OAUTH_GOOGLE_ISSUER);

  // A production build served on loopback (`pnpm dev:app`) is a local demo; anything else is public and
  // must not run on dev credentials or plain http (cookies would lose `Secure`, tokens travel in clear).
  if (production && !isLoopbackUrl(baseURL)) {
    const problems: string[] = [];
    if (e.BETTER_AUTH_SECRET === DEV_AUTH_SECRET) {
      problems.push('BETTER_AUTH_SECRET is the development default; set a random secret.');
    }
    if (!baseURL.startsWith('https://')) problems.push('BETTER_AUTH_URL must use https.');
    if (!issuer.startsWith('https://') && !isLoopbackUrl(issuer)) {
      problems.push('OAUTH_GOOGLE_ISSUER must use https.');
    }
    if (problems.length > 0) {
      throw new AuthConfigError(`Unsafe production auth config:\n  ${problems.join('\n  ')}`);
    }
  }

  return {
    secret: e.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins: (e.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((o) => stripSlash(o.trim()))
      .filter(Boolean),
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      ...(e.SMTP_USER ? { user: e.SMTP_USER } : {}),
      ...(e.SMTP_PASSWORD ? { password: e.SMTP_PASSWORD } : {}),
      from: e.SMTP_FROM,
    },
    google: {
      issuer,
      clientId: e.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: e.OAUTH_GOOGLE_CLIENT_SECRET,
    },
    ...(e.REDIS_URL ? { redisUrl: e.REDIS_URL } : {}),
    maxTeamWorkspaces: e.AUTH_MAX_TEAM_WORKSPACES ?? DEFAULT_MAX_TEAM_WORKSPACES,
    production,
  };
}
