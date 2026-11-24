/**
 * A scriptable stand-in for `oat-audio` (tests only), run as `node fake-sidecar.ts <args>`. Speaks protocol 1
 * with a constant tone so SidecarSource's crash / restart / stop-escalation paths can be tested on any OS
 * without the Swift binary. Misbehaviour is configured with the `FAKE_SIDECAR` env var (JSON, `FakeConfig`).
 */
import { existsSync, writeFileSync } from 'node:fs';

import { encodeFrame, KIND, SOURCE } from '../sidecar-protocol.ts';

export interface FakeConfig {
  /** Protocol number reported by `version` and `started`. Default 1. */
  protocol?: number;
  /** Exit with code 3 (after a stderr line) this long after start. */
  crashAfterMs?: number;
  /** Only crash if this marker file does not exist yet (creates it): crash once, then run normally. */
  crashOnceFile?: string;
  /** Write a frame with an invalid kind this long after start. */
  garbageAfterMs?: number;
  /** Ignore `stop` commands and stdin EOF. */
  ignoreStop?: boolean;
  /** Ignore SIGTERM too (only SIGKILL works). */
  ignoreTerm?: boolean;
  /** Never write `started`. */
  noStarted?: boolean;
  /** Exit with code 2 before writing anything. */
  exitBeforeStart?: boolean;
  /** Write one audio frame per source right after `started`, before any stdin command is read. */
  audioRightAfterStarted?: boolean;
  /** Send a startup warning, then wait for this file before opening capture. */
  captureReadyFile?: string;
  /** Announce the protocol but fail to open capture. */
  failToOpen?: boolean;
}

const config = JSON.parse(process.env.FAKE_SIDECAR ?? '{}') as FakeConfig;
const [command, ...args] = process.argv.slice(2);

if (command === 'version') {
  process.stdout.write(`${JSON.stringify({ version: 'fake', protocol: config.protocol ?? 1 })}\n`);
  process.exit(0);
}
if (command !== 'capture') {
  process.stderr.write(`fake-sidecar: unknown command ${command}\n`);
  process.exit(64);
}

const opt = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const sampleRate = opt('--sample-rate', 16_000);
const frameMs = opt('--frame-ms', 50);
const durationS = opt('--duration', 0);
const only = args.includes('--mic') ? ['mic'] : args.includes('--system') ? ['system'] : null;
const sources = only ?? ['mic', 'system'];
const frameSamples = Math.round((sampleRate * frameMs) / 1000);
const frameUs = Math.round((frameSamples * 1_000_000) / sampleRate);
const t0 = performance.now();
const nowUs = () => Math.round((performance.now() - t0) * 1000);
const samples: Record<string, number> = { mic: 0, system: 0 };
let paused = false;
let stopped = false;
let frameIndex = 0;

const write = (bytes: Uint8Array) => process.stdout.write(bytes);
const event = (payload: Record<string, unknown>, source: number = SOURCE.NONE) =>
  write(encodeFrame(KIND.EVENT, source, nowUs(), payload));

if (config.exitBeforeStart) {
  process.stderr.write('fake-sidecar: refusing to start\n');
  process.exit(2);
}
if (config.ignoreTerm) process.on('SIGTERM', () => undefined);

function stop(reason: string, code = 0) {
  if (stopped) return;
  stopped = true;
  clearInterval(ticker);
  event({ type: 'stopped', reason, samples });
  process.stdout.write(new Uint8Array(0), () => process.exit(code));
}

if (!config.noStarted) {
  event({
    type: 'started',
    protocol: config.protocol ?? 1,
    version: 'fake',
    sample_rate: sampleRate,
    frame_ms: frameMs,
    sources,
    synthetic: true,
    aec: false,
    ...(config.captureReadyFile || config.failToOpen ? { await_capture_ready: true } : {}),
  });
}

let ready = !config.captureReadyFile && !config.failToOpen;
const tone = Int16Array.from({ length: frameSamples }, (_, i) =>
  Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
);
if (config.audioRightAfterStarted && !config.noStarted) {
  for (const source of sources) {
    write(encodeFrame(KIND.AUDIO, source === 'mic' ? SOURCE.MIC : SOURCE.SYSTEM, 0, tone));
    samples[source] = (samples[source] ?? 0) + frameSamples;
  }
  frameIndex = 1;
}
const ticker = setInterval(() => {
  if (paused || stopped || config.noStarted) return;
  if (!ready) {
    if (!config.captureReadyFile || !existsSync(config.captureReadyFile)) return;
    ready = true;
    event({ type: 'capture_ready' });
  }
  // Emit every frame that is due (sample-count clock, like the real sidecar).
  while ((frameIndex + 1) * frameUs <= nowUs()) {
    const tUs = frameIndex * frameUs;
    for (const source of sources) {
      write(encodeFrame(KIND.AUDIO, source === 'mic' ? SOURCE.MIC : SOURCE.SYSTEM, tUs, tone));
      samples[source] = (samples[source] ?? 0) + frameSamples;
    }
    frameIndex++;
    if (durationS && frameIndex * frameUs >= durationS * 1_000_000) return stop('duration');
  }
}, 10);
if (config.failToOpen || config.captureReadyFile) {
  event(
    {
      type: 'error',
      source: 'mic',
      code: config.failToOpen ? 'mic_start_failed' : 'aec_unavailable',
      message: 'simulated microphone startup problem',
      fatal: !!config.failToOpen,
    },
    SOURCE.MIC,
  );
  process.stderr.write('fake-sidecar: opening devices\n');
  if (config.failToOpen) stop('error', 1);
}

const crashes =
  config.crashAfterMs !== undefined &&
  (config.crashOnceFile === undefined || !existsSync(config.crashOnceFile));
if (crashes) {
  if (config.crashOnceFile) writeFileSync(config.crashOnceFile, 'crashed');
  setTimeout(() => {
    process.stderr.write('fake-sidecar: simulated crash\n');
    process.exit(3);
  }, config.crashAfterMs);
}
if (config.garbageAfterMs !== undefined) {
  setTimeout(
    () => write(encodeFrame(7 as 1, SOURCE.NONE, nowUs(), new Uint8Array(4))),
    config.garbageAfterMs,
  );
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text: string) => {
  const lines = (pending + text).split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const cmd = (JSON.parse(line) as { cmd?: string }).cmd;
    if (cmd === 'pause' && !paused) {
      paused = true;
      event({ type: 'paused' });
    } else if (cmd === 'resume' && paused) {
      paused = false;
      // The real sidecar's timeline jumps forward across a pause.
      frameIndex = Math.ceil(nowUs() / frameUs);
      event({ type: 'resumed' });
    } else if (cmd === 'stop' && !config.ignoreStop) stop('command');
  }
});
process.stdin.on('end', () => {
  if (!config.ignoreStop) stop('stdin_eof');
});
