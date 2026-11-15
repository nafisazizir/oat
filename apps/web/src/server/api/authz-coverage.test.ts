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
 * Each handler needs one of (registries in `./authz-registry.ts`):
 * - a deny-case int test marked `denies('<key>')` (`./authz-markers`) in a `*.int.test.ts` under `src` —
 *   only calls in statement position count (not in comments);
 * - `PUBLIC` (no authorization by design, with the reason);
 * - `SELF_SCOPED` (takes no resource identifier; only ever touches the session user's own data) — the module
 *   must check the session (`getSession(` / `requireSession(`);
 * - `TESTED_ELSEWHERE` (the deny case lives in another package's tests): the named file must contain the
 *   named test title.
 * Entries that no longer match a handler fail too. Separately, `../entrypoints.int.test.ts` calls every
 * non-PUBLIC handler anonymously and expects a refusal (401 / redirect to sign-in).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  denyMarkers,
  exportedMethods,
  exportsOf,
  handlers,
  isUseServerModule,
  markersIn,
  ROUTE_FILE,
} from './authz-enumerate';
import { PUBLIC, SELF_SCOPED, TESTED_ELSEWHERE } from './authz-registry';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('authorization coverage', () => {
  const { keys, problems } = handlers();
  const markers = denyMarkers();
  const registries = { PUBLIC, SELF_SCOPED, TESTED_ELSEWHERE };

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
