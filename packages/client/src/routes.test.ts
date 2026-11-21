import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { createOatClient } from './index.ts';

type Endpoint = { method: string; path: string };
function endpoints(value: unknown): Endpoint[] {
  if (typeof value === 'function' && 'endpoint' in value) return [value.endpoint as Endpoint];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(endpoints);
}

it('covers every non-skipped API route and HTTP method (OAuth redirects use browser navigation)', async () => {
  const root = fileURLToPath(new URL('../../../apps/web/src/app/api/', import.meta.url));
  const expected: string[] = [];
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('/route.ts')) continue;
    const path = '/api/' + file.slice(0, -'/route.ts'.length);
    if (
      /^\/api\/(auth|sign-in|sync)\//.test(path) ||
      [
        '/api/health',
        '/api/stt/token',
        '/api/integrations/notion/connect',
        '/api/integrations/notion/callback',
      ].includes(path)
    )
      continue;
    const source = await readFile(root + file, 'utf8');
    const exports = [
      ...source.matchAll(
        /export\s+(?:const\s+\{([^}]+)\}|(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b)/g,
      ),
    ];
    const methods = exports.flatMap(
      (match) =>
        match[1]?.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? (match[2] ? [match[2]] : []),
    );
    expect(methods.length, file).toBeGreaterThan(0);
    for (const method of methods) expected.push(method + ' ' + path);
  }
  const client = createOatClient(async () => {
    throw new Error('Inventory must not dispatch');
  });
  const actual = endpoints(client).map(({ method, path }) => method + ' ' + path);
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
});
