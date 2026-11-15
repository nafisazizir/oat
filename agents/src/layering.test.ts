/** D-29 layering (8.3): the repo's ESLint config refuses app imports from the agents and from packages. */
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: `${root}/${filePath}` });
  return result!.messages.map((m) => m.ruleId);
}

describe('layering lint rule', () => {
  it('refuses imports of app code from agents/ and packages/', async () => {
    for (const [code, file] of [
      ["import { x } from '../../../apps/web/src/server/actor.ts'; void x;", 'agents/src/a/x.ts'],
      ["export * from '../../../apps/web/src/server/notion.ts';", 'agents/src/a/x.ts'],
      ["import type { X } from '@oat/web/server';\nexport type Y = X;", 'packages/core/src/x.ts'],
      ["import { y } from '@oat/desktop'; void y;", 'packages/services/src/x.ts'],
    ] as const) {
      expect(await lint(code, file), code).toContain('no-restricted-imports');
    }
  });

  it('allows the shared services package', async () => {
    const code = "import { loadActor } from '@oat/services/actor';\nvoid loadActor;";
    expect(await lint(code, 'agents/src/a/x.ts')).not.toContain('no-restricted-imports');
  });
});
