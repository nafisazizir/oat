import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { apiRoutes } from './index.ts';

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
  const actual = apiRoutes.flatMap(({ methods, path }) =>
    methods.map((method) => method + ' ' + path),
  );
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
});
