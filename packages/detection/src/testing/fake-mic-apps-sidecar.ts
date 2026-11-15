/**
 * A scriptable stand-in for `oat-audio mic-apps …` (tests only), run as `node fake-mic-apps-sidecar.ts <args>`,
 * so SidecarMicAppsSource's process handling can be tested on any OS without the Swift binary. Behaviour
 * comes from the `FAKE_MIC_APPS` env var (JSON, `FakeMicAppsConfig`).
 */
import { appendFileSync } from 'node:fs';

export interface FakeMicAppsConfig {
  /** Apps printed by `list` and as the first `watch` snapshot. */
  apps?: unknown[];
  /** Print this raw text from `list` instead. */
  listRaw?: string;
  /** Exit code for `list` (after printing nothing). */
  failWith?: number;
  /** Append each invocation's argv (JSON) to this file. */
  argsLog?: string;
  watch?: {
    /** Further `apps` snapshots, one every `everyMs` after the first. */
    snapshots?: unknown[][];
    everyMs?: number;
    /** Never print `ready`. */
    noReady?: boolean;
    /** Exit with code 3 this long after `ready`. */
    crashAfterMs?: number;
    /** Print these raw lines right after the first snapshot. */
    extraLines?: string[];
    /** Ignore stdin EOF (and SIGTERM too when `ignoreTerm`). */
    ignoreEOF?: boolean;
    ignoreTerm?: boolean;
  };
}

const config = JSON.parse(process.env.FAKE_MIC_APPS ?? '{}') as FakeMicAppsConfig;
const argv = process.argv.slice(2);
if (config.argsLog) appendFileSync(config.argsLog, `${JSON.stringify(argv)}\n`);
const [group, command] = argv;
const out = (line: string) => process.stdout.write(`${line}\n`);
const appsLine = (apps: unknown[]) => JSON.stringify({ type: 'apps', apps });

if (group !== 'mic-apps') {
  process.stderr.write(`fake: unknown command ${argv.join(' ')}\n`);
  process.exit(64);
}

if (command === 'list') {
  if (config.failWith !== undefined) {
    process.stderr.write('fake: list failed\n');
    process.exit(config.failWith);
  }
  out(config.listRaw ?? appsLine(config.apps ?? []));
  process.exit(0);
}

if (command === 'watch') {
  const w = config.watch ?? {};
  if (w.ignoreTerm) process.on('SIGTERM', () => {});
  if (!w.noReady) {
    out(JSON.stringify({ type: 'ready', source: 'fake', intervalMs: 1000 }));
    out(appsLine(config.apps ?? []));
    for (const line of w.extraLines ?? []) out(line);
    const snapshots = [...(w.snapshots ?? [])];
    const timer = setInterval(() => {
      const next = snapshots.shift();
      if (next) out(appsLine(next));
      else clearInterval(timer);
    }, w.everyMs ?? 20);
    if (w.crashAfterMs !== undefined)
      setTimeout(() => {
        process.stderr.write('fake: crashing\n');
        process.exit(3);
      }, w.crashAfterMs);
  }
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (!w.ignoreEOF) process.exit(0);
  });
  setInterval(() => {}, 1000); // stay alive
} else {
  process.stderr.write(`fake: unknown mic-apps command ${String(command)}\n`);
  process.exit(64);
}
