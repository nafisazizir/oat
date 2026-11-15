import { describe, expect, it } from 'vitest';

import { bridgeChannels, bridgeContract } from './bridge.ts';

const invoke = bridgeContract.invoke;

describe('onboarding bridge channels (9.2)', () => {
  it('are part of the contract', () => {
    for (const c of [
      'permissions:get',
      'permissions:request',
      'permissions:open-settings',
      'onboarding:get',
      'onboarding:complete',
      'onboarding:dismiss-guide',
      'onboarding:test-start',
      'onboarding:test-stop',
      'onboarding:test-get',
    ]) {
      expect(bridgeChannels.invoke).toContain(c);
    }
    for (const c of ['onboarding:test-state', 'permissions:changed']) {
      expect(bridgeChannels.subscribe).toContain(c);
    }
  });

  it('a permission request names one known permission, nothing else', () => {
    const req = invoke['permissions:request'].request;
    expect(req.safeParse({ kind: 'microphone' }).success).toBe(true);
    expect(req.safeParse({ kind: 'system_audio' }).success).toBe(true);
    expect(req.safeParse({ kind: 'calendar' }).success).toBe(true);
    expect(req.safeParse({ kind: 'camera' }).success).toBe(false);
    // No URL can be smuggled into "open settings": main picks the pane.
    expect(
      invoke['permissions:open-settings'].request.safeParse({
        kind: 'microphone',
        url: 'x-apple.systempreferences:evil',
      }).success,
    ).toBe(false);
  });

  it('the test recording takes a plain fixture name only', () => {
    const req = invoke['onboarding:test-start'].request;
    expect(req.safeParse({}).success).toBe(true);
    expect(req.safeParse({ input: 'file', fixture: 'standup-short' }).success).toBe(true);
    expect(req.safeParse({ input: 'file', fixture: '../../etc/passwd' }).success).toBe(false);
  });
});
