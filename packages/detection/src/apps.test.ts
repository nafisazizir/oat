import { describe, expect, it } from 'vitest';

import {
  HELPER_PARENTS,
  HELPER_PREFIXES,
  MEETING_APPS,
  MESSAGING_MIN_HOLD_MS,
  meetingAppById,
  meetingAppForBundleId,
  MicAppProcessSchema,
  resolveMeetingApp,
} from './apps.ts';

const idOf = (bundleId: string | null, appBundleId: string | null = null) =>
  resolveMeetingApp({ pid: 1, bundleId, appBundleId })?.id ?? null;

describe('meeting app data', () => {
  it('has unique app ids and bundle ids', () => {
    const ids = MEETING_APPS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bundles = MEETING_APPS.flatMap((a) => a.bundleIds);
    expect(new Set(bundles).size).toBe(bundles.length);
  });

  it('covers the D-21 apps and browsers', () => {
    for (const id of ['zoom', 'teams', 'slack', 'facetime', 'webex', 'discord', 'around', 'tuple'])
      expect(meetingAppById(id)?.kind, id).toBe('native');
    for (const id of ['chrome', 'arc', 'safari', 'edge', 'firefox', 'brave'])
      expect(meetingAppById(id)?.kind, id).toBe('browser');
    expect(meetingAppById('slack')?.noun).toBe('huddle');
    for (const id of ['slack', 'whatsapp', 'telegram', 'signal', 'discord'])
      expect(meetingAppById(id)?.minHoldMs, id).toBe(MESSAGING_MIN_HOLD_MS);
    for (const id of ['zoom', 'teams', 'facetime', 'webex', 'chrome'])
      expect(meetingAppById(id)?.minHoldMs, id).toBe(0);
    expect(meetingAppById('nope')).toBeNull();
  });

  it('maps every helper to a listed app', () => {
    for (const [helper, parent] of Object.entries(HELPER_PARENTS))
      expect(meetingAppForBundleId(helper), helper).toBe(meetingAppForBundleId(parent));
    for (const [, parent] of HELPER_PREFIXES) expect(meetingAppForBundleId(parent)).not.toBeNull();
  });
});

describe('resolveMeetingApp', () => {
  it('matches main bundle ids exactly', () => {
    expect(idOf('us.zoom.xos')).toBe('zoom');
    expect(idOf('com.microsoft.teams2')).toBe('teams');
    expect(idOf('com.google.Chrome.canary')).toBe('chrome');
    expect(idOf('com.apple.Safari')).toBe('safari');
  });

  it('maps helpers through the helper map', () => {
    expect(idOf('com.apple.WebKit.GPU')).toBe('safari');
    expect(idOf('com.apple.avconferenced')).toBe('facetime');
    expect(idOf('org.mozilla.plugincontainer')).toBe('firefox');
  });

  it('maps `<main id>.…` helpers to the longest listed prefix', () => {
    expect(idOf('com.google.Chrome.helper')).toBe('chrome');
    expect(idOf('com.google.Chrome.helper.renderer')).toBe('chrome');
    expect(idOf('com.microsoft.teams2.modulehost')).toBe('teams');
    expect(idOf('com.tinyspeck.slackmacgap.helper')).toBe('slack');
    expect(idOf('com.microsoft.edgemac.Beta.helper')).toBe('edge');
    // Chrome PWAs (incl. Meet's) count as Chrome.
    expect(idOf('com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan')).toBe('chrome');
  });

  it('maps vendor prefixes', () => {
    expect(idOf('us.zoom.CptHost')).toBe('zoom');
  });

  it('falls back to the containing app', () => {
    expect(idOf('com.example.unknown.helper', 'com.brave.Browser')).toBe('brave');
    expect(idOf(null, 'us.zoom.xos')).toBe('zoom');
    // The containing (user-visible) app wins: a native app's embedded web helper with a browser-like id
    // is that app, not the browser.
    expect(idOf('com.google.Chrome.helper', 'com.microsoft.teams2')).toBe('teams');
    expect(idOf('org.chromium.Chromium.helper', 'com.tinyspeck.slackmacgap')).toBe('slack');
    // An unknown container falls back to the process's own id.
    expect(idOf('com.google.Chrome.helper', 'com.example.Launcher')).toBe('chrome');
  });

  it('ignores everything else', () => {
    expect(idOf(null)).toBeNull();
    expect(idOf('')).toBeNull();
    expect(idOf('com.apple.VoiceMemos')).toBeNull();
    expect(idOf('com.google.Chromebook')).toBeNull(); // not a dotted prefix
    expect(idOf('us.zoomy.app')).toBeNull();
    expect(idOf('com.oat.desktop')).toBeNull();
  });
});

describe('MicAppProcessSchema', () => {
  it('defaults appBundleId and rejects bad shapes', () => {
    expect(MicAppProcessSchema.parse({ pid: 3, bundleId: null })).toEqual({
      pid: 3,
      bundleId: null,
      appBundleId: null,
    });
    expect(() => MicAppProcessSchema.parse({ pid: '3', bundleId: null })).toThrow();
    expect(() => MicAppProcessSchema.parse({ pid: 3 })).toThrow();
  });
});
