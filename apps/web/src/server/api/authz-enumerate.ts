/**
 * Static enumeration of the web app's request handlers (route handlers + server actions) and of the
 * `denies()` deny-case markers, shared by `authz-coverage.test.ts` and `../entrypoints.int.test.ts`
 * (D-25, 5.5). Test-only: reads source files, never imports them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = fileURLToPath(new URL('../../', import.meta.url));
export const APP_DIR = join(SRC, 'app');

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export const ROUTE_FILE = /(?:^|[\\/])route\.(?:ts|tsx|js|jsx|mjs|mts|cjs|cts)$/;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|mts|cjs|cts)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;

export function walk(dir: string): string[] {
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
export function exportsOf(source: string): { names: string[]; star: boolean } {
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

export function exportedMethods(source: string): string[] {
  return exportsOf(source)
    .names.filter((n) => METHODS.has(n))
    .sort();
}

export const isUseServerModule = (source: string) =>
  /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/.test(source);

type Problem = string;

/** Every handler key, plus problems that make enumeration impossible. */
export function handlers(): { keys: Map<string, string>; problems: Problem[] } {
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
      if (star) problems.push(`${rel}: \`export *\` in a ‘use server’ module`);
      for (const name of names) keys.set(`action ${rel}#${name}`, file);
    } else if (/['"]use server['"]/.test(stripComments(source))) {
      problems.push(`${rel}: inline ‘use server’ — move server actions into a ‘use server’ module`);
    }
  }
  return { keys, problems };
}

/** Keys named by `denies(…)` calls in statement position in `*.int.test.ts` under src. */
export function denyMarkers(): Set<string> {
  const markers = new Set<string>();
  for (const file of walk(SRC).filter((f) => f.endsWith('.int.test.ts'))) {
    for (const key of markersIn(readFileSync(file, 'utf8'))) markers.add(key);
  }
  return markers;
}

export function markersIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const keys: string[] = [];
  for (const call of code.matchAll(/^[ \t]*denies\(([^)]*)\)/gm)) {
    for (const literal of call[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)) keys.push(literal[1]!);
  }
  return keys;
}
