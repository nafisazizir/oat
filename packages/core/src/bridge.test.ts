import { describe, expect, it } from 'vitest';

import {
  bridgeChannels,
  bridgeContract,
  desktopUserSchema,
  initialMainState,
  mainStateSchema,
  mainStateSnapshotSchema,
} from './bridge.ts';

describe('bridge contract', () => {
  it('requires a main-generated compared revision before local conflict resolution', () => {
    const request = bridgeContract.invoke['conflicts:resolve'].request;
    expect(request.safeParse({ copyId: 'c', keep: 'copy', revision: 'a'.repeat(64) }).success).toBe(
      true,
    );
    expect(request.safeParse({ copyId: 'c', keep: 'copy' }).success).toBe(false);
    expect(
      request.safeParse({ copyId: 'c', keep: 'copy', revision: 'a'.repeat(64) + '\n' }).success,
    ).toBe(false);
    expect(request.safeParse({ copyId: 'c', keep: 'copy', revision: 'invalid' }).success).toBe(
      false,
    );
  });
  it('accepts fixed consent providers and workspace IDs, not arbitrary URLs or destinations', () => {
    const request = bridgeContract.invoke['settings:connect'].request;
    for (const provider of ['notion', 'google-calendar']) {
      expect(request.safeParse({ provider, workspaceId: 'team_1' }).success).toBe(true);
    }
    for (const value of [
      undefined,
      {},
      { provider: 'notion', workspaceId: '../other' },
      { provider: 'https://evil.test', workspaceId: 'team_1' },
    ]) {
      expect(request.safeParse(value).success).toBe(false);
    }
    const download = bridgeContract.invoke['settings:export-notes'].request;
    expect(download.safeParse({ workspaceId: 'team_1' }).success).toBe(true);
    expect(download.safeParse({ workspaceId: 'team_1', path: '/etc/example' }).success).toBe(false);
  });
  it('channel names are unique across invoke, send and subscribe', () => {
    const all = [...bridgeChannels.invoke, ...bridgeChannels.send, ...bridgeChannels.subscribe];
    expect(new Set(all).size).toBe(all.length);
    expect(bridgeChannels.invoke).toEqual(Object.keys(bridgeContract.invoke));
  });

  it('channel names are namespace:verb', () => {
    for (const name of [
      ...bridgeChannels.invoke,
      ...bridgeChannels.send,
      ...bridgeChannels.subscribe,
    ]) {
      expect(name).toMatch(/^[a-z]+:[a-z][a-z-]*$/);
    }
  });

  it('the initial state is valid and starts by restoring auth', () => {
    expect(mainStateSchema.parse(initialMainState())).toEqual({
      auth: { status: 'restoring' },
      recording: { status: 'idle' },
      activeMeetingId: null,
      sync: { state: 'stopped', pending: 0, parked: 0, lastSyncedAt: null, error: null },
    });
  });

  it('shapes drop unknown fields, so a token can never ride along', () => {
    expect(desktopUserSchema.parse({ id: 'u', email: 'e', name: null, token: 'secret' })).toEqual({
      id: 'u',
      email: 'e',
      name: null,
    });
    const parsed = mainStateSnapshotSchema.parse({
      seq: 1,
      token: 'secret',
      state: {
        ...initialMainState(),
        auth: { status: 'signed-in', user: { id: 'u', email: 'e', name: null }, token: 'secret' },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('rejects malformed payloads', () => {
    const link = bridgeContract.invoke['auth:complete-from-link'].request;
    expect(link.safeParse({ url: 'oat://auth' }).success).toBe(true);
    expect(link.safeParse({ url: 1 }).success).toBe(false);
    expect(link.safeParse(undefined).success).toBe(false);
    expect(bridgeContract.invoke['state:get'].request.safeParse({}).success).toBe(false);
    expect(bridgeContract.send['app:rendered'].safeParse({ window: 'other' }).success).toBe(false);
    expect(mainStateSnapshotSchema.safeParse({ seq: -1, state: initialMainState() }).success).toBe(
      false,
    );
  });
});
