/**
 * Where the compose stack (D-11) lives. Every value can be overridden by env (see `.env.example`);
 * the defaults are the fixed host ports from docker-compose.yml, so tests work without a `.env`.
 */

export const DEFAULT_DATABASE_URL = 'postgres://oat:oat@localhost:54329/oat';
export const DEFAULT_MAILPIT_URL = 'http://localhost:18025';
export const DEFAULT_MOCKS_URL = 'http://localhost:14010';
export const DEFAULT_OAUTH_GOOGLE_ISSUER = 'http://localhost:18089/google';
export const DEFAULT_SMTP = { host: 'localhost', port: 11025 } as const;

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);
const stripSlash = (url: string) => url.replace(/\/+$/, '');

export function databaseUrl(env: Env = process.env): string {
  return nonEmpty(env.DATABASE_URL) ?? DEFAULT_DATABASE_URL;
}

/**
 * Superuser connection used to CREATE/DROP test databases: `OAT_DATABASE_ADMIN_URL`, else `DATABASE_URL`
 * pointed at the `postgres` maintenance database.
 */
export function adminDatabaseUrl(env: Env = process.env): string {
  const explicit = nonEmpty(env.OAT_DATABASE_ADMIN_URL);
  if (explicit) return explicit;
  const url = new URL(databaseUrl(env));
  url.pathname = '/postgres';
  return url.toString();
}

export function mailpitUrl(env: Env = process.env): string {
  return stripSlash(nonEmpty(env.MAILPIT_URL) ?? DEFAULT_MAILPIT_URL);
}

export function mocksUrl(env: Env = process.env): string {
  return stripSlash(nonEmpty(env.MOCKS_URL) ?? DEFAULT_MOCKS_URL);
}

export function oauthGoogleIssuer(env: Env = process.env): string {
  return stripSlash(nonEmpty(env.OAUTH_GOOGLE_ISSUER) ?? DEFAULT_OAUTH_GOOGLE_ISSUER);
}

export function smtpConfig(env: Env = process.env): { host: string; port: number } {
  const port = Number(nonEmpty(env.SMTP_PORT) ?? DEFAULT_SMTP.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid SMTP_PORT: ${env.SMTP_PORT}`);
  return { host: nonEmpty(env.SMTP_HOST) ?? DEFAULT_SMTP.host, port };
}
