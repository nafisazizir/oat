/**
 * SidecarMicAppsSource + Detector against the real `oat-audio` binary in **fixture mode only** (`--fixture`:
 * the sidecar replays a timeline file and never touches Core Audio — never run `mic-apps` without it here).
 * Skipped unless on macOS with the binary built (`pnpm --filter @oat/audio build:sidecar`) or `OAT_AUDIO_BIN`
 * set.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { locateSidecarBinary } from '@oat/audio/node';

import type { MicAppProcess } from './apps.ts';
import type { DetectionAction } from './detect.ts';
import { Detector } from './detector.ts';
import { SidecarMicAppsSource } from './sidecar-source.ts';
import type { MicAppsWatch } from './source.ts';
import { compactAction, DetectionTimelineSchema } from './timeline.ts';

function findBinary(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return locateSidecarBinary();
  } catch {
    return undefined;
  }
}
const BINARY = findBinary();
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/detection/${name}`, import.meta.url));
const REPLAY = fixture('sidecar-replay.json');

/** Fixture-backed source; `fixture` is mandatory so no test can reach Core Audio by accident. */
const sidecar = (file: string, intervalMs = 50) =>
  new SidecarMicAppsSource({ binary: BINARY!, fixture: file, intervalMs });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

describe.skipIf(!BINARY)(
  'oat-audio mic-apps (real binary, fixture mode)',
  { timeout: 20_000 },
  () => {
    it('list returns the timeline state at start', async () => {
      expect(await sidecar(REPLAY).list()).toEqual([]);
      expect(await sidecar(fixture('helpers.json')).list()).toEqual([
        { pid: 900, bundleId: 'com.microsoft.teams2.modulehost', appBundleId: null },
        { pid: 901, bundleId: 'com.microsoft.teams2', appBundleId: null },
        { pid: 902, bundleId: null, appBundleId: null },
        { pid: 903, bundleId: 'com.apple.VoiceMemos', appBundleId: null },
      ]);
    });

    it('watch replays the timeline as change-only snapshots and stops on EOF', async () => {
      const seen: MicAppProcess[][] = [];
      const errors: Error[] = [];
      const watch: MicAppsWatch = await sidecar(REPLAY).watch(
        (apps) => seen.push(apps),
        (e) => errors.push(e),
      );
      cleanup.push(() => watch.stop());
      await expect.poll(() => seen.length, { timeout: 8000 }).toBe(4);
      expect(seen.map((apps) => apps.map((a) => a.pid))).toEqual([
        [],
        [300, 501],
        [300, 501, 700],
        [],
      ]);
      expect(seen[2]![2]).toEqual({
        pid: 700,
        bundleId: 'com.google.Chrome.helper',
        appBundleId: 'com.google.Chrome',
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toHaveLength(4); // nothing after the timeline ends
      await watch.stop();
      expect(errors).toEqual([]);
    });

    it('Detector over the sidecar produces the fixture actions in real time', async () => {
      const timeline = DetectionTimelineSchema.parse(JSON.parse(readFileSync(REPLAY, 'utf8')));
      const detector = new Detector({ source: sidecar(REPLAY) });
      const actions: DetectionAction[] = [];
      detector.onAction((a) => actions.push(a));
      const errors: Error[] = [];
      detector.onError((e) => errors.push(e));
      const started = Date.now();
      await detector.start();
      cleanup.push(() => detector.stop());
      await expect.poll(() => actions.length, { timeout: 10_000, interval: 100 }).toBe(3);
      // Same actions as the virtual-clock run; times within the poll interval + process start jitter.
      const compact = actions.map((a) => compactAction(a, started));
      expect(compact.map(({ type }) => type)).toEqual(timeline.expect.map(({ type }) => type));
      expect(compact[0]).toMatchObject({ type: 'prompt', app: 'zoom', event: null });
      expect(compact[2]).toMatchObject({
        type: 'meetingEnded',
        apps: ['zoom'],
        recording: false,
      });
      timeline.expect.forEach((want, i) => {
        expect(
          Math.abs(compact[i]!.at - want.at),
          `${want.type} at ${compact[i]!.at}`,
        ).toBeLessThan(1000);
      });
      expect(errors).toEqual([]);
    });
  },
);
