/** Server-side auth for Oat (Better Auth). Browser code imports `@oat/auth/client` instead. */
export const packageName = '@oat/auth';

export { ac, roles, statements, type WorkspaceRoleName } from './access.ts';
export {
  authConfigFromEnv,
  AuthConfigError,
  DEFAULT_MAX_TEAM_WORKSPACES,
  DEV_AUTH_SECRET,
  isLoopbackUrl,
  type AuthConfig,
  type OidcProviderConfig,
  type SmtpConfig,
} from './config.ts';
export { DESKTOP_CODE_TTL_SECONDS, desktopAuth, desktopCodeIdentifier } from './desktop.ts';
export * from './desktop-link.ts';
export {
  createSmtpMailer,
  escapeHtml,
  magicLinkEmail,
  type EmailMessage,
  type Mailer,
} from './email.ts';
export {
  isBlockedAuthPath,
  MAGIC_LINK_CONFIRM_PATH,
  MAGIC_LINK_CONSUME_PATH,
  MAGIC_LINK_VERIFY_PATH,
  magicLinkConfirmUrl,
  magicLinkVerifyUrl,
} from './magic-link.ts';
export { magicLinkIdentifier, peekMagicLinkEmail } from './magic-link-lookup.ts';
export { GOOGLE_PROVIDER_ID } from './providers.ts';
export {
  createMemoryRateLimiter,
  createRateLimiter,
  createRedisRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from './rate-limit.ts';
export {
  createAuth,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_EXPIRES_IN,
  type Auth,
  type CreateAuthOptions,
} from './server.ts';
export {
  ensurePersonalWorkspace,
  findPersonalWorkspaceId,
  listUserWorkspaces,
  loadPermissionContext,
  PERSONAL_SLUG_PREFIX,
  PERSONAL_WORKSPACE_NAME,
  personalWorkspaceSlug,
  pickActiveWorkspace,
  teamWorkspaceSlug,
  type UserWorkspace,
} from './workspaces.ts';
