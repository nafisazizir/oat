import { describe, expect, it } from 'vitest';

import manifest from '../../package.json' with { type: 'json' };

import { workspacePackages } from './workspace-packages';

describe('workspacePackages (next.config transpilePackages)', () => {
  it('picks every @oat/* dependency and nothing else', () => {
    expect(
      workspacePackages({
        dependencies: { '@oat/ui': 'workspace:*', next: '16', '@oatmeal/x': '1' },
        devDependencies: { '@oat/testkit': 'workspace:*' },
      }),
    ).toEqual(['@oat/testkit', '@oat/ui']);
    expect(workspacePackages({})).toEqual([]);
  });

  it("covers this app's own workspace dependencies", () => {
    const declared = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, version]) => version.startsWith('workspace:'))
      .map(([name]) => name);
    expect(workspacePackages(manifest)).toEqual(declared.toSorted());
    expect(workspacePackages(manifest)).toContain('@oat/ui');
  });
});
