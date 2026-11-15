import { describe, expect, it } from 'vitest';

import { syncLabel } from './sync-status.ts';

const s = (
  state: 'idle' | 'syncing' | 'offline' | 'error' | 'stopped',
  pending = 0,
  parked = 0,
) => ({
  state,
  pending,
  parked,
  lastSyncedAt: null,
  error: null,
});

describe('syncLabel', () => {
  it('says nothing when signed out', () => {
    expect(syncLabel(s('stopped', 3))).toBeNull();
  });

  it('describes each state, with the pending count', () => {
    expect(syncLabel(s('idle'))).toEqual({ tone: 'ok', text: 'All changes synced' });
    expect(syncLabel(s('idle', 1))).toEqual({ tone: 'waiting', text: '1 change waiting to sync' });
    expect(syncLabel(s('syncing'))!.text).toBe('Syncing…');
    expect(syncLabel(s('syncing', 4))!.text).toBe('Syncing 4 changes…');
    expect(syncLabel(s('offline', 12))).toEqual({
      tone: 'offline',
      text: 'Offline — 12 changes saved on this Mac',
    });
    expect(syncLabel(s('offline'))!.text).toMatch(/everything is saved/);
    expect(syncLabel(s('error', 2))!.tone).toBe('problem');
    expect(syncLabel(s('idle', 0, 2))).toEqual({
      tone: 'problem',
      text: '2 changes couldn’t sync — kept on this Mac, retrying later',
    });
  });
});
