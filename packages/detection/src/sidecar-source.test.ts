/**
 * SidecarMicAppsSource against a scriptable fake (`testing/fake-mic-apps-sidecar.ts`, run with this Node):
 * argument building, output parsing and watch process lifecycle — on any OS.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SidecarError } from '@oat/audio/node';

import type { MicAppProcess } from './apps.ts';
import { SidecarMicAppsSource, type SidecarMicAppsSourceOptions } from './sidecar-source.ts';
import type { MicAppsWatch } from './source.ts';
import type { FakeMicAppsConfig } from './testing/fake-mic-apps-sidecar.ts';

const FAKE = fileURLToPath(new URL('./testing/fake-mic-apps-sidecar.ts', import.meta.url));
const ZOOM = { pid: 501, bundleId: 'us.zoom.xos', appBundleId: null };
const CHROME = { pid: 700, bundleId: 'com.google.Chrome.helper', appBundleId: 'com.google.Chrome' };

function fake(config: FakeMicAppsConfig = {}, options: SidecarMicAppsSourceOptions = {}) {
  return new SidecarMicAppsSource({
    binary: { command: process.execPath, args: [FAKE] },
    env: { ...process.env, FAKE_MIC_APPS: JSON.stringify(config) },
    ...options,
  });
}

const argsLog = () => join(mkdtempSync(join(tmpdir(), 'oat-micapps-')), 'args.jsonl');
const readArgs = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[]);

const watches: MicAppsWatch[] = [];
afterEach(async () => {
  await Promise.all(watches.splice(0).map((w) => w.stop()));
});

describe('SidecarMicAppsSource (fake sidecar)', () => {
  it('lists with fixture arguments', async () => {
    const log = argsLog();
    const source = fake({ apps: [ZOOM], argsLog: log }, { fixture: '/tmp/t.json' });
    expect(source.name).toBe('fixture');
    expect(await source.list()).toEqual([ZOOM]);
    expect(readArgs(log)).toEqual([['mic-apps', 'list', '--fixture', '/tmp/t.json']]);
    expect(fake().name).toBe('coreaudio');
  });

  it('rejects failures and bad list output', async () => {
    await expect(fake({ failWith: 1 }).list()).rejects.toBeInstanceOf(SidecarError);
    await expect(fake({ listRaw: 'nope' }).list()).rejects.toThrow(/printed "nope"/);
    await expect(fake({ listRaw: '{"type":"ready"}' }).list()).rejects.toThrow(/unexpected line/);
    await expect(fake({ listRaw: '{"type":"apps","apps":[{"pid":"x"}]}' }).list()).rejects.toThrow(
      /bad apps line/,
    );
  });

  it('watches: first snapshot, then changes; passes interval; ignores unknown lines', async () => {
    const log = argsLog();
    const stderr: string[] = [];
    const source = fake(
      {
        apps: [],
        argsLog: log,
        watch: {
          snapshots: [[ZOOM], [ZOOM, CHROME]],
          extraLines: [
            'not json',
            '{"type":"future_thing"}',
            '{"type":"error","code":"poll_failed","message":"HAL busy"}',
          ],
        },
      },
      { intervalMs: 250, onStderr: (l) => stderr.push(l) },
    );
    const seen: MicAppProcess[][] = [];
    const errors: Error[] = [];
    const watch = await source.watch(
      (apps) => seen.push(apps),
      (e) => errors.push(e),
    );
    watches.push(watch);
    await expect.poll(() => seen.length, { timeout: 5000 }).toBe(3);
    expect(seen).toEqual([[], [ZOOM], [ZOOM, CHROME]]);
    expect(readArgs(log)).toEqual([['mic-apps', 'watch', '--interval-ms', '250']]);
    expect(stderr.some((l) => l.includes('non-JSON'))).toBe(true);
    expect(stderr.some((l) => l.includes('poll_failed: HAL busy'))).toBe(true);
    await watch.stop();
    await watch.stop(); // idempotent
    expect(errors).toEqual([]);
  });

  it('reports a crash after ready through onError', async () => {
    const errors: Error[] = [];
    const watch = await fake({ watch: { crashAfterMs: 100 } }).watch(
      () => {},
      (e) => errors.push(e),
    );
    watches.push(watch);
    await expect.poll(() => errors.length, { timeout: 5000 }).toBe(1);
    expect(errors[0]).toBeInstanceOf(SidecarError);
    expect(errors[0]!.message).toMatch(/exited with 3.*crashing/);
  });

  it('fails the watch on a malformed apps line', async () => {
    const errors: Error[] = [];
    const watch = await fake({ watch: { extraLines: ['{"type":"apps","apps":"zoom"}'] } }).watch(
      () => {},
      (e) => errors.push(e),
    );
    watches.push(watch);
    await expect.poll(() => errors.length, { timeout: 5000 }).toBe(1);
    expect(errors[0]!.message).toMatch(/without an apps array/);
  });

  it('rejects when ready never comes', async () => {
    await expect(
      fake({ watch: { noReady: true } }, { readyTimeoutMs: 200 }).watch(
        () => {},
        () => {},
      ),
    ).rejects.toThrow(/no "ready"/);
  });

  it('escalates to SIGTERM / SIGKILL when the sidecar ignores EOF', async () => {
    const watch = await fake(
      { watch: { ignoreEOF: true, ignoreTerm: true } },
      { stopTimeoutMs: 100 },
    ).watch(
      () => {},
      () => {},
    );
    const t = Date.now();
    await watch.stop();
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
  });
});
