/**
 * A scriptable stand-in for `oat-audio calendar …` (tests only), run as `node fake-calendar-sidecar.ts <args>`,
 * so SidecarCalendarSource's process handling can be tested on any OS without the Swift binary or EventKit.
 * Behaviour comes from the `FAKE_CALENDAR` env var (JSON, `FakeCalendarConfig`).
 */
import { appendFileSync } from 'node:fs';

export interface FakeCalendarConfig {
  /** `calendar status` value; `events`/`watch` exit 77 unless `full_access`. Default `full_access`. */
  access?: string;
  /** Lines printed by `calendar events` (objects are JSON-encoded, strings printed raw). */
  events?: unknown[];
  /** Exit code for `status`/`events` (after printing nothing). */
  failWith?: number;
  /** Print garbage instead of JSON from `status`. */
  garbageStatus?: boolean;
  /** Append each invocation's argv (JSON) to this file. */
  argsLog?: string;
  watch?: {
    /** Emit `changed` this often after `ready`. */
    changeEveryMs?: number;
    /** Stop emitting after this many `changed` lines. */
    maxChanges?: number;
    /** Exit with code 3 this long after `ready`. */
    crashAfterMs?: number;
    /** Never print `ready`. */
    noReady?: boolean;
    /** Ignore stdin EOF (and SIGTERM too when `ignoreTerm`). */
    ignoreEOF?: boolean;
    ignoreTerm?: boolean;
  };
}

const config = JSON.parse(process.env.FAKE_CALENDAR ?? '{}') as FakeCalendarConfig;
const argv = process.argv.slice(2);
if (config.argsLog) appendFileSync(config.argsLog, `${JSON.stringify(argv)}\n`);
const [group, command] = argv;
const access = config.access ?? 'full_access';
const canRead = access === 'full_access';
const out = (line: string) => process.stdout.write(`${line}\n`);

if (group !== 'calendar') {
  process.stderr.write(`fake: unknown command ${group}\n`);
  process.exit(64);
}
if (config.failWith !== undefined && command !== 'watch') {
  process.stderr.write('fake: failing on purpose\n');
  process.exit(config.failWith);
}

if (command === 'status') {
  out(
    config.garbageStatus
      ? 'not json'
      : JSON.stringify({ status: access, canRead, source: 'fake', prompted: false }),
  );
  process.exit(0);
}

if (!canRead) {
  process.stderr.write(`oat-audio: calendar: calendar access is ${access}\n`);
  process.exit(77);
}

if (command === 'events') {
  for (const e of config.events ?? []) out(typeof e === 'string' ? e : JSON.stringify(e));
  process.exit(0);
}

if (command === 'watch') {
  const w = config.watch ?? {};
  if (w.ignoreTerm) process.on('SIGTERM', () => {});
  if (!w.ignoreEOF) {
    process.stdin.on('end', () => process.exit(0));
  }
  process.stdin.resume();
  if (!w.noReady) out(JSON.stringify({ type: 'ready', source: 'fake' }));
  out('{"type":"some_future_type"}');
  if (w.changeEveryMs) {
    let n = 0;
    const timer = setInterval(() => {
      out(JSON.stringify({ type: 'changed' }));
      if (++n >= (w.maxChanges ?? Infinity)) clearInterval(timer);
    }, w.changeEveryMs);
  }
  if (w.crashAfterMs !== undefined) {
    setTimeout(() => {
      process.stderr.write('fake: crashing\n');
      process.exit(3);
    }, w.crashAfterMs);
  }
  setInterval(() => {}, 1 << 30); // stay alive
} else {
  process.stderr.write(`fake: unknown calendar command ${command}\n`);
  process.exit(64);
}
