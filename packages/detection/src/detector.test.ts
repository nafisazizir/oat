import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectionAction } from './detect.ts';
import { Detector } from './detector.ts';
import { FixtureMicAppsSource, type MicAppsSource } from './source.ts';
import { timelineEvent } from './timeline.ts';

const T0 = new Date('2026-11-16T17:00:00Z');
const ZOOM = { pid: 501, bundleId: 'us.zoom.xos' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(options: Partial<ConstructorParameters<typeof Detector>[0]> = {}) {
  const source = new FixtureMicAppsSource();
  const detector = new Detector({ source, ...options });
  const actions: { at: number; action: DetectionAction }[] = [];
  detector.onAction((action) => actions.push({ at: Date.now() - T0.getTime(), action }));
  const summary = () => actions.map((a) => `${a.at}:${a.action.type}`);
  return { source, detector, actions, summary };
}

describe('Detector', () => {
  it('drives the reducer from the source and its own timers', async () => {
    const { source, detector, summary } = setup();
    await detector.start();
    expect(source.watcherCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    source.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(summary()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(summary()).toEqual(['3000:prompt']);
    await vi.advanceTimersByTimeAsync(10_000);
    source.setApps([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(summary()).toEqual(['3000:prompt', '15000:dismiss', '15000:meetingEnded']);
    await detector.stop();
    expect(source.watcherCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the state after every input (the call span opening and closing, for 7.5)', async () => {
    const { source, detector } = setup();
    const open: boolean[] = [];
    const off = detector.onState((s) => {
      const now = s.meeting !== null;
      if (open.at(-1) !== now) open.push(now);
    });
    await detector.start();
    source.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2000);
    source.setApps([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(open).toEqual([false, true, false]);
    off();
    await detector.stop();
  });

  it('feeds recording, calendar, silence and promptClosed', async () => {
    const { source, detector, actions } = setup({ silenced: ['slack'] });
    detector.setEvents([
      timelineEvent({
        id: 'sync',
        title: 'Sync',
        start: '2026-11-16T17:00:00Z',
        end: '2026-11-16T17:30:00Z',
      }),
    ]);
    await detector.start();
    source.setApps([ZOOM, { pid: 600, bundleId: 'com.tinyspeck.slackmacgap' }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(actions.map((a) => a.action)).toMatchObject([
      { type: 'prompt', app: { id: 'zoom' }, event: { title: 'Sync' } },
    ]);
    const prompt = actions[0]!.action;
    detector.promptClosed(prompt.type === 'prompt' ? prompt.promptId : '');
    expect(detector.state.prompt).toBeNull();
    detector.setRecording(true);
    source.setApps([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(actions.at(-1)?.action).toMatchObject({
      type: 'meetingEnded',
      recording: true,
      eventId: 'eventkit:sync',
    });
    detector.setSilenced([]);
    expect(detector.state.silenced).toEqual([]);
    await detector.stop();
  });

  it('starts once, reports a dying source, and surfaces start failures', async () => {
    let die: ((e: Error) => void) | undefined;
    const source: MicAppsSource = {
      name: 'flaky',
      list: async () => [],
      watch: async (_onApps, onError) => {
        die = onError;
        return { stop: async () => {} };
      },
    };
    const detector = new Detector({ source });
    const errors: Error[] = [];
    detector.onError((e) => errors.push(e));
    await detector.start();
    await detector.start(); // no-op
    die!(new Error('sidecar crashed'));
    expect(errors.map((e) => e.message)).toEqual(['sidecar crashed']);
    await detector.stop();

    const broken = new Detector({
      source: { ...source, watch: async () => Promise.reject(new Error('no binary')) },
    });
    await expect(broken.start()).rejects.toThrow('no binary');
    await expect(broken.start()).rejects.toThrow('no binary'); // can retry
  });

  it('unsubscribes listeners', async () => {
    const { source, detector, actions } = setup();
    const off = detector.onAction(() => {});
    off();
    await detector.start();
    source.setApps([ZOOM]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(actions).toHaveLength(1);
    await detector.stop();
  });
});

describe('FixtureMicAppsSource', () => {
  it('lists, notifies watchers with full lists and validates input', async () => {
    const source = new FixtureMicAppsSource([ZOOM]);
    expect(await source.list()).toEqual([{ ...ZOOM, appBundleId: null }]);
    const seen: unknown[] = [];
    const watch = await source.watch((apps) => seen.push(apps));
    source.setApps([]);
    await watch.stop();
    source.setApps([ZOOM]);
    expect(seen).toEqual([[{ ...ZOOM, appBundleId: null }], []]);
    expect(() => source.setApps([{ pid: 'x' } as never])).toThrow();
  });
});
