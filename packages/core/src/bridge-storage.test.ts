import { describe, expect, it } from 'vitest';

import { bridgeChannels, bridgeContract } from './bridge.ts';
import {
  retentionPolicySchema,
  storageInvokeChannels,
  storageSubscribeChannels,
} from './bridge-storage.ts';

describe('storage bridge channels (3.8)', () => {
  it('are part of the contract', () => {
    for (const name of Object.keys(storageInvokeChannels)) {
      expect(bridgeChannels.invoke).toContain(name);
    }
    for (const name of Object.keys(storageSubscribeChannels)) {
      expect(bridgeChannels.subscribe).toContain(name);
    }
  });

  it('retention policies are bounded', () => {
    const ok = [
      { kind: 'forever' },
      { kind: 'age', days: 1 },
      { kind: 'age', days: 3650 },
      { kind: 'size', gb: 0.1 },
      { kind: 'size', gb: 2.5 },
    ];
    for (const p of ok)
      expect(retentionPolicySchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
    const bad = [
      {},
      { kind: 'age' },
      { kind: 'age', days: 0 },
      { kind: 'age', days: 1.5 },
      { kind: 'age', days: 99999 },
      { kind: 'size', gb: 0 },
      { kind: 'size', gb: -1 },
      { kind: 'size', gb: Number.POSITIVE_INFINITY },
      { kind: 'size', gb: '5' },
      { kind: 'forever', days: 3 }, // strict: no stray fields
      { kind: 'everything' },
    ];
    for (const p of bad)
      expect(retentionPolicySchema.safeParse(p).success, JSON.stringify(p)).toBe(false);
  });

  it('meeting ids can never name a path', () => {
    const del = bridgeContract.invoke['storage:delete-audio'].request;
    expect(del.safeParse({ meetingId: '019a-abc_D' }).success).toBe(true);
    for (const meetingId of ['..', '../x', 'a/b', '.hidden', '', '/etc', 'a\\b', 'x'.repeat(129)]) {
      expect(del.safeParse({ meetingId }).success, meetingId).toBe(false);
    }
    expect(del.safeParse({ meetingId: 'm1', path: '/etc' }).success).toBe(false);
    expect(
      bridgeContract.invoke['storage:show'].request.safeParse({ meetingId: '..' }).success,
    ).toBe(false);
  });
});
