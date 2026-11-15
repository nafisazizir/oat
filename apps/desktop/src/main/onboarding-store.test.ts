import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingStore } from './onboarding-store.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-onboarding-'));
  file = join(dir, 'onboarding.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const log = { warn: vi.fn() };

describe('OnboardingStore', () => {
  it('first run per account: needed until completed, then the guide until dismissed', () => {
    const store = new OnboardingStore({ file, mode: 'auto', log, now: () => 1000 });
    expect(store.state(null)).toEqual({ needed: false, guide: false });
    expect(store.state('u1')).toEqual({ needed: true, guide: false });
    expect(store.complete('u1', true)).toEqual({ needed: false, guide: true });
    // Another account on the same Mac still gets its own setup.
    expect(store.state('u2')).toEqual({ needed: true, guide: false });
    expect(store.dismissGuide('u1')).toEqual({ needed: false, guide: false });

    // Survives a relaunch.
    const again = new OnboardingStore({ file, mode: 'auto', log });
    expect(again.state('u1')).toEqual({ needed: false, guide: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      accounts: { u1: { completedAt: 1000, guide: false } },
    });
  });

  it('"Set up later" completes without the guide; re-running setup keeps the first date', () => {
    let now = 1;
    const store = new OnboardingStore({ file, mode: 'auto', log, now: () => now });
    store.complete('u1', false);
    now = 2;
    expect(store.complete('u1', true)).toEqual({ needed: false, guide: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts.u1.completedAt).toBe(1);
  });

  it('mode off never shows the walkthrough by itself', () => {
    const store = new OnboardingStore({ file, mode: 'off', log });
    expect(store.state('u1')).toEqual({ needed: false, guide: false });
    expect(store.complete('u1', true)).toEqual({ needed: false, guide: true });
  });

  it('an unreadable file starts over (shows setup again) instead of failing', () => {
    writeFileSync(file, '{ nope');
    const store = new OnboardingStore({ file, mode: 'auto', log });
    expect(store.state('u1').needed).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });
});
