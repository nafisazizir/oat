import { describe, expect, it } from 'vitest';

import { shouldRefresh } from './use-sync-events';

describe('shouldRefresh', () => {
  const now = 100_000;
  const saved = new Map([['mine', now - 1_000]]);
  const ev = (patch: Partial<Parameters<typeof shouldRefresh>[0]>) => ({
    seq: '1.1',
    tables: ['document'],
    ids: [],
    ...patch,
  });

  it('refreshes for documents changed elsewhere, tree tables and membership changes', () => {
    expect(shouldRefresh(ev({ ids: ['other'] }), saved, now)).toBe(true);
    expect(shouldRefresh(ev({ tables: ['folder'] }), saved, now)).toBe(true);
    expect(shouldRefresh(ev({ tables: ['workspace'], workspaces: true }), saved, now)).toBe(true);
  });

  it('skips this tab’s own recent saves and changes it can’t read', () => {
    expect(shouldRefresh(ev({ ids: ['mine'] }), saved, now)).toBe(false);
    expect(shouldRefresh(ev({ ids: [] }), saved, now)).toBe(false);
    expect(shouldRefresh(ev({ ids: ['mine'] }), saved, now + 10_000)).toBe(true);
  });
});
