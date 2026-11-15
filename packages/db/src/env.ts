/** Environment for the `db:*` CLIs (tests use `@oat/testkit`). */
import { existsSync } from 'node:fs';

/** The compose Postgres (D-11, docs/DEV.md). */
export const DEFAULT_DATABASE_URL = 'postgres://oat:oat@localhost:54329/oat';

const ROOT_ENV = new URL('../../../.env', import.meta.url);

/** Loads the repo-root `.env` if present; variables already set in the shell win. */
export function loadRootEnv(): void {
  if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
}

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL?.trim();
  return url ? url : DEFAULT_DATABASE_URL;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalDatabase(url: string): boolean {
  return LOOPBACK.has(new URL(url).hostname);
}

/** `postgres://user:***@host/db` for logs. */
export function redactUrl(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
