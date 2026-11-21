/**
 * Handlers that don't carry a `denies('<key>')` deny-case marker, each with its reason (D-25, 5.5). Read by
 * `authz-coverage.test.ts` (every handler is accounted for) and `entrypoints.int.test.ts` (everything not
 * PUBLIC refuses an anonymous caller). Test-only, no dependencies. Keys as in `authz-markers.ts`.
 */

/** No authorization by design. */
export const PUBLIC: Readonly<Record<string, string>> = {
  'GET /api/health': 'Liveness probe; returns only version and database status.',
  'GET /api/auth/[...all]':
    'Better Auth’s own endpoints; it authenticates itself. Inventory + reasons: @oat/auth endpoints.test.ts.',
  'POST /api/auth/[...all]':
    'Better Auth’s own endpoints; it authenticates itself. Inventory + reasons: @oat/auth endpoints.test.ts.',
  'POST /api/sign-in/magic-link':
    'Redeems a single-use magic-link token (same-origin only); signing in is the point.',
};

/**
 * Takes no resource identifier and only ever touches the session user's own data. The module must check
 * the session (`getSession(` / `requireSession(`).
 */
export const SELF_SCOPED: Readonly<Record<string, string>> = {
  'GET /api/calendar/upcoming': 'Reads the session user’s own calendar connection; no resource id.',
  'action server/actions/calendar.ts#disconnectGoogleCalendarAction':
    'Disconnects the session user’s own Google calendar; no resource id.',
  'action server/actions/workspaces.ts#createWorkspace':
    'Creates a workspace owned by the session user (per-user cap in @oat/auth); no resource id.',
  'action server/actions/joining.ts#createMyWorkspace':
    'Creates the session user’s first workspace, only while they have none (@oat/auth createOwnWorkspace); no resource id.',
};

/**
 * The deny case lives in another package's tests (the named file must contain the named test title).
 * Prefer a `denies()` marker on a test of the handler itself; use this only when it can't run here.
 */
export const TESTED_ELSEWHERE: Readonly<Record<string, { file: string; test: string }>> = {};
