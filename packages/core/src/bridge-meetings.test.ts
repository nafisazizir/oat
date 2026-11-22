import { describe, expect, it } from 'vitest';

import { bridgeChannels, bridgeContract } from './bridge.ts';

const invoke = bridgeContract.invoke;

describe('meeting bridge channels (3.4)', () => {
  it('are part of the contract', () => {
    for (const c of [
      'meetings:list',
      'meeting:get',
      'meeting:load',
      'meeting:transcript',
      'meeting:save',
      'meeting:add-participant',
      'meeting:remove-participant',
    ]) {
      expect(bridgeChannels.invoke).toContain(c);
    }
    expect(bridgeChannels.subscribe).toContain('meetings:changed');
    expect(bridgeChannels.subscribe).toContain('notes:flush');
    expect(bridgeChannels.send).toContain('notes:flushed');
  });
  it('validates read-through requests and does not expose arbitrary response fields', () => {
    const channel = invoke['meeting:load'];
    expect(channel.request.safeParse({ documentId: 'd1' }).success).toBe(true);
    expect(channel.request.safeParse({ documentId: 'd1', token: 'secret' }).success).toBe(false);
    expect(channel.response.parse({ state: 'offline', token: 'secret' })).toEqual({
      state: 'offline',
    });
    expect(channel.response.safeParse({ state: 'ready' }).success).toBe(false);
  });

  it('meeting:get takes a document id or a meeting id, not both or neither', () => {
    const req = invoke['meeting:get'].request;
    expect(req.safeParse({ documentId: 'd1' }).success).toBe(true);
    expect(req.safeParse({ meetingId: 'm-1' }).success).toBe(true);
    expect(req.safeParse({ meetingId: '../etc' }).success).toBe(false);
    expect(req.safeParse({ documentId: 'd1', meetingId: 'm1' }).success).toBe(false);
    expect(req.safeParse({}).success).toBe(false);
  });

  it('validates saves and participants', () => {
    const save = invoke['meeting:save'].request;
    const base = { title: 'T', contentJson: { type: 'doc' } };
    expect(
      save.safeParse({ documentId: 'd1', base, contentJson: { type: 'doc', content: [] } }).success,
    ).toBe(true);
    // The base the editor started from is required (no blind overwrite).
    expect(
      save.safeParse({ documentId: 'd1', contentJson: { type: 'doc', content: [] } }).success,
    ).toBe(false);
    expect(
      save.safeParse({ documentId: 'd1', base, contentJson: { type: 'paragraph' } }).success,
    ).toBe(false);
    expect(save.safeParse({ documentId: 'd1', base, title: 'x'.repeat(201) }).success).toBe(false);
    const add = invoke['meeting:add-participant'].request;
    expect(add.safeParse({ documentId: 'd1', name: ' Ada ', email: null }).data?.name).toBe('Ada');
    expect(add.safeParse({ documentId: 'd1', name: 'Ada', email: 'ada@example.com' }).success).toBe(
      true,
    );
    expect(add.safeParse({ documentId: 'd1', name: 'Ada', email: 'nope' }).success).toBe(false);
    expect(add.safeParse({ documentId: 'd1', name: '  ', email: null }).success).toBe(false);
  });
});
