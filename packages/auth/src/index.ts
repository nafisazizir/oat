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
  emailSafeText,
  escapeHtml,
  invitationEmail,
  joinDecisionEmail,
  joinRequestEmail,
  unlinkable,
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
export {
  type AccountTokenApi,
  disconnectGoogleCalendar,
  findGoogleCalendarConnection,
  GOOGLE_CALENDAR_PROVIDER_ID,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleCalendarConnection,
  googleCalendarTokenProvider,
  parseScopes,
  revokeOAuthToken,
} from './google-calendar.ts';
export {
  changeMemberRole,
  deleteWorkspace,
  findInvite,
  findInviteByToken,
  findLiveWorkspace,
  INVITE_EXPIRES_IN,
  inviteAlreadyHonoured,
  inviterMayStillInvite,
  inviteState,
  inviteTokenFor,
  isLiveWorkspace,
  isNotFoundError,
  leaveWorkspace,
  listMembers,
  listPendingInvites,
  NotFoundError,
  removeMember,
  WORKSPACE_RESTORE_DAYS,
  type InviteDetails,
  type InviteState,
  type PendingInvite,
  type WorkspaceMember,
  type WorkspaceSummary,
} from './members.ts';
export { GOOGLE_PROVIDER_ID } from './providers.ts';
export {
  createMemoryRateLimiter,
  createRateLimiter,
  createRedisRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from './rate-limit.ts';
export {
  decryptSecret,
  encryptSecret,
  secretConfigFromEnv,
  type SecretSource,
  secretSourceFromEnv,
} from './secrets.ts';
export {
  BLOCKED_ORGANIZATION_PATHS,
  DISABLED_AUTH_PATHS,
  INVITE_EMAIL_LIMITS,
  createAuth,
  inviteUrl,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_EXPIRES_IN,
  type Auth,
  type CreateAuthOptions,
} from './server.ts';
export {
  addOwnDomain,
  createOwnWorkspace,
  decideJoinRequest,
  ensureFirstWorkspace,
  type FirstWorkspace,
  getJoinChoices,
  hasAnyJoinChoice,
  getJoinSettings,
  hasJoinChoices,
  type InviteChoice,
  isJoinRequestDecidedError,
  type JoinableWorkspace,
  type JoinChoices,
  type JoinDecision,
  type JoinDecisionNotice,
  type JoinRequestNotice,
  JoinRequestDecidedError,
  joinRequestsUrl,
  type JoinSettings,
  joinWorkspace,
  listableDomain,
  listJoinRequests,
  type PendingJoinRequest,
  removeDomain,
  requestToJoin,
  sendJoinDecisionEmail,
  sendJoinRequestEmails,
  setJoinPolicy,
} from './joining.ts';
export {
  FALLBACK_WORKSPACE_NAME,
  findFirstWorkspaceId,
  firstWorkspaceName,
  lastActiveWorkspaceId,
  listUserWorkspaces,
  loadPermissionContext,
  pickActiveWorkspace,
  rememberActiveWorkspace,
  startingWorkspaceId,
  type UserWorkspace,
  workspaceSlug,
} from './workspaces.ts';
