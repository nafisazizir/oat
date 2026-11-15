/**
 * Authorization coverage (D-25; 5.3, groundwork for 5.5). Fails closed: every request handler the web app
 * exposes must be accounted for, or CI fails.
 *
 * Handlers:
 * - route handlers: every `route.(ts|tsx|js|jsx|mjs|mts|cjs|cts)` anywhere under `src/app`, keyed
 *   `'<METHOD> /<path under app>'`. A route file that re-exports with `export *`, or exports no recognised
 *   HTTP method, fails (its handlers can't be enumerated).
 * - server actions (they are POST endpoints too): every export of a `'use server'` module under `src`,
 *   keyed `'action <module under src>#<export>'`. A `'use server'` directive anywhere else (inline actions
 *   inside components/functions) fails: define actions in a module so they can be enumerated.
 *
 * Each handler needs one of:
 * - a deny-case int test marked `denies('<key>')` (`./authz-markers`) in a `*.int.test.ts` under `src` —
 *   only calls in statement position count (not in comments);
 * - `PUBLIC` (no authorization by design, with the reason);
 * - `SELF_SCOPED` (takes no resource identifier; only ever touches the session user's own data) — the module
 *   must check the session (`getSession(` / `requireSession(`);
 * - `TESTED_ELSEWHERE` (the deny case lives in another package's tests): the named file must contain the
 *   named test title;
 * - `KNOWN_GAPS` (pre-existing actions whose deny case isn't tested yet; owed by 5.5). Never add to it.
 * Entries that no longer match a handler fail too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const APP_DIR = join(SRC, 'app');

const PUBLIC: Record<string, string> = {
  'GET /api/health': 'Liveness probe; returns only version and database status.',
  'GET /api/auth/[...all]':
    'Better Auth’s own endpoints (sign-in, session); it authenticates itself.',
  'POST /api/auth/[...all]':
    'Better Auth’s own endpoints (sign-in, session); it authenticates itself.',
  'POST /api/sign-in/magic-link':
    'Redeems a single-use magic-link token (same-origin only); signing in is the point.',
};

const SELF_SCOPED: Record<string, string> = {
  'GET /api/calendar/upcoming': 'Reads the session user’s own calendar connection; no resource id.',
  'action server/actions/calendar.ts#disconnectGoogleCalendarAction':
    'Disconnects the session user’s own Google calendar; no resource id.',
  'action server/actions/workspaces.ts#createTeamWorkspace':
    'Creates a workspace owned by the session user (per-user cap in @oat/auth); no resource id.',
};

const MEMBERS_TESTS = 'packages/auth/src/members.int.test.ts';
const TESTED_ELSEWHERE: Record<string, { file: string; test: string }> = {
  'action server/actions/members.ts#changeRole': {
    file: MEMBERS_TESTS,
    test: 'deny: admin demotes owner, admin grants owner, admin demotes admin, member/viewer change roles',
  },
  'action server/actions/members.ts#removeMember': {
    file: MEMBERS_TESTS,
    test: 'deny: admin removes owner or admin, member/viewer remove others, last owner removed',
  },
  'action server/actions/members.ts#leaveWorkspace': {
    file: MEMBERS_TESTS,
    test: 'anyone may leave, except the last owner',
  },
  'action server/actions/members.ts#deleteWorkspace': {
    file: MEMBERS_TESTS,
    test: 'only the owner deletes; the workspace disappears everywhere but the rows remain',
  },
  'action server/actions/members.ts#inviteMember': {
    file: MEMBERS_TESTS,
    test: 'admin invites members but not owners; members and viewers cannot invite',
  },
  'action server/actions/members.ts#resendInvite': {
    file: MEMBERS_TESTS,
    test: 'resend re-checks the workspace and the inviter',
  },
  'action server/actions/members.ts#revokeInvite': {
    file: MEMBERS_TESTS,
    test: 'members and viewers cannot revoke invites',
  },
  'action server/actions/members.ts#acceptInvite': {
    file: MEMBERS_TESTS,
    test: 'an invite cannot be accepted by a different email',
  },
};

/** Debt, not policy: handlers that predate this gate and have no deny-case test yet (5.5). */
const KNOWN_GAPS: Record<string, string> = {
  'action server/actions/workspaces.ts#switchWorkspace':
    'Better Auth refuses non-members; only the deleted-workspace case is tested.',
  'action server/actions/members.ts#updateWorkspace':
    'assertCan(manageMembers) — core-tested, the action itself is not.',
  'action server/actions/members.ts#declineInvite':
    'Recipient-email check in the action is untested (only the happy path is).',
};

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ROUTE_FILE = /(?:^|[\\/])route\.(?:ts|tsx|js|jsx|mjs|mts|cjs|cts)$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|mts|cjs|cts)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
    return [path];
  });
}

const posix = (path: string) => path.split(sep).join('/');

/** Source without comments (strings containing comment markers are rare here and only over-strip). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Names a module exports; `star` when it has an `export *` (can't be enumerated statically). */
function exportsOf(source: string): { names: string[]; star: boolean } {
  const code = stripComments(source);
  const names = new Set<string>();
  const decl =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(decl)) names.add(m[1]!);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.split(':').at(-1)?.trim().split(/\s|=/)[0];
      if (name) names.add(name);
    }
  }
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+/).at(-1);
      if (name) names.add(name);
    }
  }
  return { names: [...names], star: /export\s*\*/.test(code) };
}

function exportedMethods(source: string): string[] {
  return exportsOf(source)
    .names.filter((n) => METHODS.has(n))
    .sort();
}

const isUseServerModule = (source: string) =>
  /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/.test(source);

type Problem = string;

/** Every handler key, plus problems that make enumeration impossible. */
function handlers(): { keys: Map<string, string>; problems: Problem[] } {
  const keys = new Map<string, string>(); // key → file
  const problems: Problem[] = [];
  for (const file of walk(APP_DIR).filter((f) => ROUTE_FILE.test(f))) {
    const source = readFileSync(file, 'utf8');
    const rel = posix(relative(SRC, file));
    const route = `/${posix(relative(APP_DIR, file)).split('/').slice(0, -1).join('/')}`;
    const { star } = exportsOf(source);
    const methods = exportedMethods(source);
    if (star) problems.push(`${rel}: \`export *\` hides which handlers it exports`);
    if (methods.length === 0) problems.push(`${rel}: no recognised HTTP method exports`);
    for (const method of methods) keys.set(`${method} ${route}`, file);
  }
  for (const file of walk(SRC).filter((f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f))) {
    const source = readFileSync(file, 'utf8');
    const rel = posix(relative(SRC, file));
    if (isUseServerModule(source)) {
      const { names, star } = exportsOf(source);
      if (star) problems.push(`${rel}: \`export *\` in a 'use server' module`);
      for (const name of names) keys.set(`action ${rel}#${name}`, file);
    } else if (/['"]use server['"]/.test(stripComments(source))) {
      problems.push(`${rel}: inline 'use server' — move server actions into a 'use server' module`);
    }
  }
  return { keys, problems };
}

/** Keys named by `denies(…)` calls in statement position in `*.int.test.ts` under src. */
function denyMarkers(): Set<string> {
  const markers = new Set<string>();
  for (const file of walk(SRC).filter((f) => f.endsWith('.int.test.ts'))) {
    for (const key of markersIn(readFileSync(file, 'utf8'))) markers.add(key);
  }
  return markers;
}

function markersIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const keys: string[] = [];
  for (const call of code.matchAll(/^[ \t]*denies\(([^)]*)\)/gm)) {
    for (const literal of call[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)) keys.push(literal[1]!);
  }
  return keys;
}

describe('authorization coverage', () => {
  const { keys, problems } = handlers();
  const markers = denyMarkers();
  const registries = { PUBLIC, SELF_SCOPED, TESTED_ELSEWHERE, KNOWN_GAPS };

  it('finds the route handlers and server actions', () => {
    expect([...keys.keys()]).toEqual(
      expect.arrayContaining([
        'GET /api/documents/[id]',
        'PATCH /api/documents/[id]/share',
        'POST /api/auth/[...all]',
        'action server/actions/members.ts#changeRole',
      ]),
    );
  });

  it('every handler can be enumerated', () => {
    expect(problems).toEqual([]);
  });

  it('every handler has a deny-case test or a reasoned registry entry', () => {
    const accounted = (key: string) =>
      markers.has(key) || Object.values(registries).some((r) => key in r);
    const missing = [...keys.keys()].filter((k) => !accounted(k)).sort();
    expect(
      missing,
      'Add an int test where a signed-in user without permission is refused and mark it with ' +
        "denies('<key>') (src/server/api/authz-markers.ts), or add a reasoned entry above.",
    ).toEqual([]);
  });

  it('self-scoped handlers check the session', () => {
    for (const key of Object.keys(SELF_SCOPED)) {
      const file = keys.get(key);
      if (!file) continue; // reported as stale below
      expect(readFileSync(file, 'utf8'), key).toMatch(/\b(?:getSession|requireSession)\(/);
    }
  });

  it('deny cases tested elsewhere exist', () => {
    for (const [key, { file, test }] of Object.entries(TESTED_ELSEWHERE)) {
      expect(readFileSync(join(REPO, file), 'utf8'), `${key} → ${file}`).toContain(test);
    }
  });

  it('registries and markers only name existing handlers, and never twice', () => {
    const named = [...Object.values(registries).flatMap((r) => Object.keys(r)), ...markers];
    expect(named.filter((k) => !keys.has(k))).toEqual([]);
    const registered = Object.values(registries).flatMap((r) => Object.keys(r));
    expect(registered.filter((k, i) => registered.indexOf(k) !== i || markers.has(k))).toEqual([]);
  });
});

describe('enumeration (bypass cases)', () => {
  it.each([
    ['export const { GET, PATCH } = api.document;', ['GET', 'PATCH']],
    ['export async function POST(request: Request) {}', ['POST']],
    ['export function GET() {}\nexport const dynamic = "force-dynamic";', ['GET']],
    ['export { handler as GET, handler as POST };', ['GET', 'POST']],
    ['export const DELETE = handler;', ['DELETE']],
    ['export { GET } from "./other";', ['GET']],
    ['const GET = 1; export const runtime = "nodejs";', []],
    ['// export async function GET() {}', []],
    ['/* export const POST = x; */', []],
  ])('methods of %j', (source, expected) => {
    expect(exportedMethods(source)).toEqual(expected);
  });

  it('flags `export *` re-exports', () => {
    expect(exportsOf("export * from './handlers';").star).toBe(true);
    expect(exportsOf("export * as api from './handlers';").star).toBe(true);
    expect(exportsOf("export { GET } from './handlers';").star).toBe(false);
  });

  it('recognises route files of every module extension, anywhere under app', () => {
    for (const name of [
      'app/api/x/route.ts',
      'app/api/x/route.tsx',
      'app/api/x/route.js',
      'app/api/x/route.mjs',
      'app/api/x/route.mts',
      'app/(app)/feed/route.ts',
      'app/share/[token]/rss/route.js',
    ]) {
      expect(ROUTE_FILE.test(name), name).toBe(true);
    }
    for (const name of ['app/api/x/router.ts', 'app/api/x/route.test.txt', 'app/api/x/page.tsx']) {
      expect(ROUTE_FILE.test(name), name).toBe(false);
    }
  });

  it('server actions: module directive vs inline', () => {
    expect(isUseServerModule("'use server';\nexport async function a() {}")).toBe(true);
    expect(isUseServerModule('/** doc */\n"use server";\nexport const b = 1;')).toBe(true);
    expect(isUseServerModule("import x from 'y';\n'use server';")).toBe(false);
    expect(
      exportsOf("'use server';\nexport async function a() {}\nexport const b = async () => {};")
        .names,
    ).toEqual(['a', 'b']);
  });

  it('only counts markers in statement position, not in comments', () => {
    const source = [
      "    denies('GET /api/a', 'POST /api/a');",
      "    // denies('GET /api/b');",
      "    /* denies('GET /api/c'); */",
      '    /*',
      "     * denies('GET /api/d');",
      '     */',
      '    const note = "call denies(\'GET /api/e\')";',
      "  denies(\n    'PATCH /api/f',\n  );",
    ].join('\n');
    expect(markersIn(source)).toEqual(['GET /api/a', 'POST /api/a', 'PATCH /api/f']);
  });
});
