import 'server-only';

import {
  type Auth,
  type AuthConfig,
  authConfigFromEnv,
  createAuth,
  createSmtpMailer,
  type Mailer,
} from '@oat/auth';

import { getDb } from './db';

/*
 * The Better Auth instance (`@oat/auth`), created lazily on first use: building it reads env and the
 * Google provider fetches OIDC discovery, neither of which may happen during `next build`.
 */
const globalForAuth = globalThis as typeof globalThis & {
  __oatAuth?: Auth;
  __oatAuthConfig?: AuthConfig;
  __oatMailer?: Mailer;
};

export function getAuthConfig(): AuthConfig {
  globalForAuth.__oatAuthConfig ??= authConfigFromEnv(process.env);
  return globalForAuth.__oatAuthConfig;
}

export function getAuth(): Auth {
  globalForAuth.__oatAuth ??= createAuth({ db: getDb(), config: getAuthConfig() });
  return globalForAuth.__oatAuth;
}

/**
 * The app's own transactional mail (join requests and decisions), over the same SMTP settings Better Auth
 * sends sign-in links and invitations with (Mailpit in dev, D-11).
 */
export function getMailer(): Mailer {
  globalForAuth.__oatMailer ??= createSmtpMailer(getAuthConfig().smtp);
  return globalForAuth.__oatMailer;
}
