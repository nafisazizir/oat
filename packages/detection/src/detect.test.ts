/**
 * Edge cases of the rules that the fixture timelines don't pin down: exact boundaries, purity, input
 * ordering, deferral vs. cancellation, eligibility, `nextDeadline`, and calendar changes while an app waits.
 */
import { describe, expect, it } from 'vitest';

import { MESSAGING_MIN_HOLD_MS, type MicAppProcessInput } from './apps.ts';
import {
  DEFAULT_DETECTION_CONFIG,
  detect,
  initialDetectionState,
  nextDeadline,
  promptTitle,
  type DetectionAction,
  type DetectionInput,
  type DetectionState,
} from './detect.ts';
import { timelineEvent } from './timeline.ts';

const T0 = Date.parse('2026-11-16T17:00:00Z');
const ZOOM: MicAppProcessInput = { pid: 501, bundleId: 'us.zoom.xos' };
const TEAMS: MicAppProcessInput = { pid: 900, bundleId: 'com.microsoft.teams2' };
const SLACK: MicAppProcessInput = { pid: 600, bundleId: 'com.tinyspeck.slackmacgap' };
const CHROME: MicAppProcessInput = { pid: 700, bundleId: 'com.google.Chrome.helper' };

const event = (id: string, start: string, end: string, extra: object = {}) =>
  timelineEvent({ id, title: id, start, end, ...extra });

/** Feeds inputs at ms offsets from T0; returns the state and every action with its offset. */
class Harness {
  state: DetectionState = initialDetectionState({ now: new Date(T0) });
  log: { at: number; action: DetectionAction }[] = [];

  at(ms: number, input: DetectionInput): DetectionAction[] {
    const r = detect(this.state, input, new Date(T0 + ms));
    this.state = r.state;
    for (const action of r.actions) this.log.push({ at: ms, action });
    return r.actions;
  }

  apps(ms: number, ...apps: MicAppProcessInput[]) {
    return this.at(ms, { type: 'micApps', apps });
  }

  tick(ms: number) {
    return this.at(ms, { type: 'tick' });
  }

  close(ms: number) {
    return this.at(ms, { type: 'promptClosed', promptId: this.state.prompt!.id });
  }

  types() {
    return this.log.map((l) => `${l.at}:${l.action.type}`);
  }
}

describe('detect: boundaries', () => {
  it('prompts exactly at the prompt delay, not before', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    expect(h.tick(1999)).toEqual([]);
    expect(h.tick(2000).map((a) => a.type)).toEqual(['prompt']);
  });

  it('removes an app exactly at the gone debounce, not before', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000);
    h.close(2100);
    h.apps(5000);
    expect(h.tick(6999)).toEqual([]);
    expect(h.tick(7000).map((a) => a.type)).toEqual(['meetingEnded']);
  });

  it('prompts a messaging app exactly at its minimum hold', () => {
    const h = new Harness();
    h.apps(0, SLACK);
    expect(nextDeadline(h.state)).toBe(T0 + 2000);
    h.tick(2000);
    expect(nextDeadline(h.state)).toBe(T0 + MESSAGING_MIN_HOLD_MS);
    expect(h.tick(MESSAGING_MIN_HOLD_MS - 1)).toEqual([]);
    expect(h.state.meeting).toBeNull(); // not a call yet
    expect(h.tick(MESSAGING_MIN_HOLD_MS)).toMatchObject([{ type: 'prompt', app: { id: 'slack' } }]);
    expect(h.state.meeting).not.toBeNull();
  });

  it('a current calendar event short-circuits the minimum hold', () => {
    const h = new Harness();
    h.at(0, {
      type: 'calendar',
      events: [event('huddle', '2026-11-16T17:00:00Z', '2026-11-16T17:15:00Z')],
    });
    h.apps(0, SLACK);
    expect(h.tick(2000)).toMatchObject([{ type: 'prompt', event: { id: 'eventkit:huddle' } }]);
  });

  it('defers a rate-limited prompt to exactly when the limit expires', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000); // prompt 1
    h.close(2500);
    h.apps(3000);
    h.tick(5000); // meeting ended
    h.apps(60_000, TEAMS);
    expect(h.tick(62_000)).toEqual([]); // eligible, but rate limited → deferred
    expect(h.state.presences[0]).toMatchObject({ eligible: true, candidate: 'pending' });
    expect(nextDeadline(h.state)).toBe(T0 + 122_000);
    expect(h.tick(121_999)).toEqual([]);
    expect(h.tick(122_000)).toMatchObject([{ type: 'prompt', app: { id: 'teams' } }]);
    expect(h.types()).toEqual(['2000:prompt', '5000:meetingEnded', '122000:prompt']);
  });

  it('defers while another prompt is on screen, then prompts when it is gone and the limit allows', () => {
    const h = new Harness();
    h.apps(0, ZOOM, TEAMS); // both due at 2000: zoom (id order) prompts, teams waits
    expect(h.tick(2000)).toMatchObject([{ type: 'prompt', app: { id: 'teams' } }]);
    expect(h.state.presences.find((p) => p.app.id === 'zoom')?.candidate).toBe('pending');
    // The on-screen prompt times out at the same moment the rate limit expires: zoom prompts then.
    expect(h.tick(122_000)).toMatchObject([
      { type: 'dismiss', reason: 'timeout' },
      { type: 'prompt', app: { id: 'zoom' } },
    ]);
  });

  it('a deferred app that leaves before the limit expires never prompts', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000);
    h.close(3000);
    h.apps(10_000, ZOOM, TEAMS);
    h.tick(12_000); // teams deferred
    h.apps(20_000, ZOOM); // teams leaves
    h.tick(22_000);
    expect(nextDeadline(h.state)).toBeNull(); // no rate-limit wake-up left
    expect(h.log.filter((l) => l.action.type === 'prompt')).toHaveLength(1);
  });

  it('times a prompt out exactly after promptTimeoutMs', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000);
    expect(h.tick(121_999)).toEqual([]);
    expect(h.tick(122_000)).toMatchObject([{ type: 'dismiss', reason: 'timeout' }]);
  });
});

describe('detect: behaviour', () => {
  it('is pure: the input state is not modified', () => {
    const s0 = initialDetectionState({ now: new Date(T0) });
    const snapshot = structuredClone(s0);
    const r1 = detect(s0, { type: 'micApps', apps: [ZOOM] }, new Date(T0));
    expect(s0).toEqual(snapshot);
    const s1 = structuredClone(r1.state);
    detect(r1.state, { type: 'micApps', apps: [] }, new Date(T0 + 1000));
    detect(r1.state, { type: 'tick' }, new Date(T0 + 5000));
    expect(r1.state).toEqual(s1);
  });

  it('never goes back in time', () => {
    const h = new Harness();
    h.apps(10_000, ZOOM);
    h.apps(5_000); // late input: treated as happening at 10000
    expect(h.state.now).toBe(T0 + 10_000);
    expect(h.state.presences[0]!.goneSince).toBe(T0 + 10_000);
  });

  it('rebases on a large backwards clock jump so timers keep their remaining time', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000); // prompt; rate limit until 122000, timeout at 122000
    h.close(2500);
    h.apps(10_000, ZOOM, TEAMS); // teams at 10000, deferred at 12000
    h.tick(12_000);
    // The next input reads one hour earlier: stored times shift by the whole observed step (time that
    // passed during the jump can't be known).
    const jump = -3_600_000;
    expect(h.tick(12_000 + jump)).toEqual([]);
    expect(h.state.now).toBe(T0 + 12_000 + jump);
    expect(nextDeadline(h.state)).toBe(T0 + 122_000 + jump); // rate limit, shifted
    expect(h.tick(122_000 + jump - 1)).toEqual([]);
    expect(h.tick(122_000 + jump)).toMatchObject([{ type: 'prompt', app: { id: 'teams' } }]);
    // A small backwards step is clamped instead.
    h.tick(122_000 + jump - 5000);
    expect(h.state.now).toBe(T0 + 122_000 + jump);
  });

  it('ignores promptClosed for another prompt', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.tick(2000);
    h.at(2100, { type: 'promptClosed', promptId: 'prompt-99' });
    expect(h.state.prompt?.id).toBe('prompt-1');
    h.at(2200, { type: 'promptClosed', promptId: 'prompt-1' });
    expect(h.state.prompt).toBeNull();
  });

  it('a gone-but-debouncing app that returns after the delay still prompts', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.apps(1000); // released before the delay
    expect(h.tick(2000)).toEqual([]);
    expect(h.apps(2500, ZOOM).map((a) => a.type)).toEqual(['prompt']); // back within 2 s
  });

  it('keeps one presence across pid changes and reports the current pid', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    h.apps(1000, { pid: 999, bundleId: 'us.zoom.CptHost' }); // other Zoom process: same presence
    expect(h.state.presences).toMatchObject([{ since: T0, pid: 999, goneSince: null }]);
    expect(h.tick(2000)).toMatchObject([{ type: 'prompt', pid: 999, bundleId: 'us.zoom.CptHost' }]);
  });

  it('two apps due at once: native before browser', () => {
    const h = new Harness();
    h.at(0, {
      type: 'calendar',
      events: [event('sync', '2026-11-16T17:00:00Z', '2026-11-16T17:30:00Z')],
    });
    h.apps(0, CHROME, ZOOM);
    expect(h.tick(2000)).toMatchObject([
      { type: 'prompt', app: { id: 'zoom' }, event: { id: 'eventkit:sync' } },
    ]);
    // Chrome is in the same meeting; the event was prompted for → Chrome is done, not deferred.
    expect(h.state.presences.find((p) => p.app.id === 'chrome')?.candidate).toBe('done');
  });

  it('a browser waiting for the calendar prompts as soon as a matching event arrives', () => {
    const h = new Harness();
    h.apps(0, CHROME);
    expect(h.tick(2000)).toEqual([]);
    expect(h.state.presences[0]).toMatchObject({ eligible: false, candidate: 'pending' });
    expect(h.state.meeting).toBeNull();
    expect(nextDeadline(h.state)).toBeNull(); // nothing on the calendar to wait for
    const actions = h.at(60_000, {
      type: 'calendar',
      events: [event('Ad-hoc', '2026-11-16T17:00:30Z', '2026-11-16T17:30:00Z')],
    });
    expect(actions).toMatchObject([
      { type: 'prompt', app: { id: 'chrome' }, event: { title: 'Ad-hoc' } },
    ]);
    expect(h.state.meeting).toMatchObject({ startedAt: T0, prompted: true });
  });

  it('recording and silence cancel for good; the app still counts as a meeting', () => {
    const rec = new Harness();
    rec.at(0, { type: 'recording', recording: true });
    rec.apps(1000, ZOOM);
    rec.tick(3000);
    expect(rec.state.presences[0]).toMatchObject({ eligible: true, candidate: 'done' });
    rec.at(4000, { type: 'recording', recording: false });
    expect(rec.tick(200_000)).toEqual([]); // no late prompt after recording stops
    expect(rec.state.meeting).toMatchObject({ recordingStarted: false, prompted: false });

    const sil = new Harness();
    sil.at(0, { type: 'silenced', appIds: ['zoom'] });
    sil.apps(0, ZOOM);
    sil.tick(2000);
    expect(sil.state.presences[0]!.candidate).toBe('done');
    expect(nextDeadline(sil.state)).toBeNull();
  });

  it('meetingEnded: recordingStartedDuringMeeting only for recordings started at/after the call began', () => {
    const before = new Harness();
    before.at(0, { type: 'recording', recording: true }); // in-person meeting being recorded
    before.apps(60_000, ZOOM);
    before.tick(62_000); // eligible (recording → no prompt)
    before.apps(90_000);
    expect(before.tick(92_000)).toMatchObject([
      {
        type: 'meetingEnded',
        recording: true,
        recordingStartedDuringMeeting: false,
        prompted: false,
      },
    ]);

    const during = new Harness();
    during.apps(0, ZOOM);
    during.tick(2000);
    during.close(3000);
    during.at(3000, { type: 'recording', recording: true }); // started from the prompt
    during.apps(60_000);
    expect(during.tick(62_000)).toMatchObject([
      {
        type: 'meetingEnded',
        recording: true,
        recordingStartedDuringMeeting: true,
        prompted: true,
      },
    ]);

    // Recording started after the app took the mic but before it became eligible still counts.
    const early = new Harness();
    early.apps(0, SLACK);
    early.at(5000, { type: 'recording', recording: true });
    early.tick(15_000);
    expect(early.state.meeting).toMatchObject({ startedAt: T0, recordingStarted: true });
  });

  it('a voice note during a recording leaves no trace', () => {
    const h = new Harness();
    h.at(0, { type: 'recording', recording: true });
    h.apps(10_000, SLACK);
    h.apps(18_000); // 8 s clip
    h.tick(20_000);
    expect(h.log).toEqual([]);
    expect(h.state.meeting).toBeNull();
  });

  it('meetingEnded reports the latest release time when apps leave at different times', () => {
    const h = new Harness();
    h.apps(0, ZOOM, TEAMS);
    h.tick(2000);
    h.apps(5000, TEAMS);
    h.apps(6500); // zoom gone at 5000 (removed at 7000), teams (prompted) gone at 6500
    expect(h.tick(7000)).toEqual([]);
    expect(h.tick(8500)).toMatchObject([
      { type: 'dismiss', reason: 'app_gone' },
      { type: 'meetingEnded', appIds: ['zoom', 'teams'], endedAt: new Date(T0 + 6500) },
    ]);
  });

  it('prunes prompted event ids once the event has ended', () => {
    const h = new Harness();
    h.at(0, {
      type: 'calendar',
      events: [event('short', '2026-11-16T17:00:00Z', '2026-11-16T17:05:00Z')],
    });
    h.apps(0, ZOOM);
    h.tick(2000);
    expect(h.state.promptedEventIds).toEqual(['eventkit:short']);
    h.close(3000);
    h.apps(400_000);
    h.tick(402_000);
    expect(h.state.promptedEventIds).toEqual([]);
  });

  it('respects a custom config', () => {
    const state = initialDetectionState({
      now: new Date(T0),
      config: { promptDelayMs: 500, goneDebounceMs: 100 },
    });
    expect(state.config).toEqual({
      ...DEFAULT_DETECTION_CONFIG,
      promptDelayMs: 500,
      goneDebounceMs: 100,
    });
    const r = detect(state, { type: 'micApps', apps: [ZOOM] }, new Date(T0));
    expect(nextDeadline(r.state)).toBe(T0 + 500);
  });
});

describe('nextDeadline', () => {
  it('is null when idle', () => {
    expect(nextDeadline(initialDetectionState())).toBeNull();
  });

  it('returns the earliest of delay, debounce and timeout', () => {
    const h = new Harness();
    h.apps(0, ZOOM);
    expect(nextDeadline(h.state)).toBe(T0 + 2000);
    h.tick(2000);
    expect(nextDeadline(h.state)).toBe(T0 + 122_000); // prompt timeout
    h.apps(10_000);
    expect(nextDeadline(h.state)).toBe(T0 + 12_000); // debounce
  });

  it('wakes a waiting browser when an event window opens', () => {
    const h = new Harness();
    h.at(0, {
      type: 'calendar',
      events: [
        event('later', '2026-11-16T17:10:00Z', '2026-11-16T17:30:00Z'),
        event('declined', '2026-11-16T17:05:00Z', '2026-11-16T17:30:00Z', { declined: true }),
      ],
    });
    h.apps(0, CHROME);
    h.tick(2000);
    expect(nextDeadline(h.state)).toBe(Date.parse('2026-11-16T17:10:00Z') - 90_000);
  });
});

describe('promptTitle', () => {
  it('uses the event title, else app + noun', () => {
    const h = new Harness();
    h.apps(0, SLACK);
    const [prompt] = h.tick(MESSAGING_MIN_HOLD_MS);
    expect(prompt?.type).toBe('prompt');
    if (prompt?.type !== 'prompt') return;
    expect(promptTitle(prompt)).toBe('Slack huddle');
    const e = event('Weekly sync', '2026-11-16T17:00:00Z', '2026-11-16T18:00:00Z');
    expect(promptTitle({ ...prompt, event: e })).toBe('Weekly sync');
    expect(promptTitle({ ...prompt, event: { ...e, title: '' } })).toBe('Slack huddle');
  });
});
