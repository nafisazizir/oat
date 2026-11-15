import { describe, expect, it } from 'vitest';

import { bridgeChannels, bridgeContract, liveSegmentSchema } from './bridge.ts';
import { storedSegmentSchema } from './bridge-meetings.ts';
import { transcriptInvokeChannels } from './bridge-transcript.ts';

describe('transcript resilience bridge channels (2.7)', () => {
  it('are part of the contract', () => {
    for (const name of Object.keys(transcriptInvokeChannels)) {
      expect(bridgeChannels.invoke).toContain(name);
    }
  });

  it('the status request takes a meeting id only (folder-name rule)', () => {
    const request = bridgeContract.invoke['meeting:transcript-status'].request;
    expect(request.safeParse({ meetingId: '0190a1b2-c3d4' }).success).toBe(true);
    expect(request.safeParse({ meetingId: '../x' }).success).toBe(false);
    expect(request.safeParse({ meetingId: 'm', path: '/etc' }).success).toBe(false);
  });

  it('segments may be flagged as back-filled (optional, so older payloads still parse)', () => {
    const live = { id: 's', source: 'mic', startMs: 0, endMs: 1, text: 'x', isFinal: true };
    expect(liveSegmentSchema.parse(live)).toEqual(live);
    expect(liveSegmentSchema.parse({ ...live, backfilled: true }).backfilled).toBe(true);
    const stored = { id: 's', source: 'system', speaker: null, startMs: 0, endMs: 1, text: 'x' };
    expect(storedSegmentSchema.parse({ ...stored, backfilled: true }).backfilled).toBe(true);
  });
});
