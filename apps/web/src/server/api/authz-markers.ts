/**
 * Authorization coverage markers (5.3, D-25). Test-only, no dependencies, so any int test can import it.
 */

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Marks the test it is called in as an authorization deny case of these handlers. Spelling:
 * - route handlers: `'<METHOD> /<path under src/app>'`, e.g. `'PATCH /api/documents/[id]'`;
 * - server actions: `'action <module under src>#<export>'`, e.g. `'action server/actions/members.ts#changeRole'`.
 *
 * A no-op at runtime: `authz-coverage.test.ts` reads the calls statically (statement position only — calls
 * inside comments don't count) and fails CI when a handler has no deny case. Call it in a test that asserts
 * a signed-in user *without* permission is refused (403/404/error result), not just the anonymous 401.
 */
export function denies(
  ...handlers: readonly (`${Method} /${string}` | `action ${string}#${string}`)[]
): void {
  void handlers;
}
