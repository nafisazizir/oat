#!/usr/bin/env node
// Contract test for the oat-audio wire protocol (PROTOCOL.md, protocol 1). No dependencies.
//
// CLI:  oat-audio capture ... | node scripts/check-frames.mjs [options]
//   --expect-seconds <s>  each expected source carries s seconds of audio (± 1 frame)
//   --max-seconds <s>     each source carries at most s seconds of audio (+ 1 frame)
//   --sources <list>      expected sources, comma-separated (default: from the `started` event)
//   --json                print the summary as JSON on stdout
// Exit 0 = valid, 1 = contract violation, 2 = usage error.
//
// Library (task 2.4 reuses this): import { FrameParser, validateFrames, KIND, SOURCE } from './check-frames.mjs'

import { pathToFileURL } from 'node:url';

export const HEADER_SIZE = 14;
export const KIND = Object.freeze({ AUDIO: 1, EVENT: 2 });
export const SOURCE = Object.freeze({ MIC: 0, SYSTEM: 1, NONE: 255 });
export const SOURCE_NAMES = Object.freeze({ 0: 'mic', 1: 'system', 255: 'none' });
const MAX_PAYLOAD = 16 * 1024 * 1024;

/** Incremental parser: push(chunk) returns complete frames; `pending` is leftover byte count. */
export class FrameParser {
  #buf = Buffer.alloc(0);

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    let off = 0;
    while (this.#buf.length - off >= HEADER_SIZE) {
      const kind = this.#buf.readUInt8(off);
      const source = this.#buf.readUInt8(off + 1);
      const tUs = this.#buf.readBigUInt64LE(off + 2);
      const len = this.#buf.readUInt32LE(off + 10);
      if (kind !== KIND.AUDIO && kind !== KIND.EVENT) throw new Error(`unknown frame kind ${kind} at byte ${off}`);
      if (!(source in SOURCE_NAMES)) throw new Error(`unknown source ${source} at byte ${off}`);
      if (len > MAX_PAYLOAD) throw new Error(`payload too large (${len}) at byte ${off}`);
      if (this.#buf.length - off - HEADER_SIZE < len) break;
      const payload = this.#buf.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len);
      const frame = { kind, source, sourceName: SOURCE_NAMES[source], tUs, payload: Buffer.from(payload) };
      if (kind === KIND.EVENT) {
        try {
          frame.event = JSON.parse(payload.toString('utf8'));
        } catch (e) {
          throw new Error(`event payload is not JSON at byte ${off}: ${e.message}`);
        }
      }
      frames.push(frame);
      off += HEADER_SIZE + len;
    }
    this.#buf = this.#buf.subarray(off);
    return frames;
  }

  get pending() {
    return this.#buf.length;
  }
}

/**
 * Validate a full capture (frames from `started` to `stopped`). Returns { errors, summary }.
 * opts: { expectSeconds?, maxSeconds?, sources?: string[], trailingBytes?: number }
 */
export function validateFrames(frames, opts = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);
  const events = frames.filter((f) => f.kind === KIND.EVENT);
  const started = events.find((f) => f.event?.type === 'started');
  const stopped = events.find((f) => f.event?.type === 'stopped');

  if (!frames.length) fail('no frames');
  if (frames.length && frames[0].event?.type !== 'started') fail('first frame is not a `started` event');
  if (frames.length && frames.at(-1).event?.type !== 'stopped') fail('last frame is not a `stopped` event');
  if (events.filter((f) => f.event?.type === 'started').length > 1) fail('more than one `started` event');
  if (events.filter((f) => f.event?.type === 'stopped').length > 1) fail('more than one `stopped` event');
  if (opts.trailingBytes) fail(`${opts.trailingBytes} trailing bytes after the last complete frame`);

  for (const f of events) {
    if (typeof f.event?.type !== 'string') fail(`event without string "type" at t_us=${f.tUs}`);
  }
  if (started && started.event.protocol !== 1) fail(`unsupported protocol ${started.event.protocol}`);

  const sampleRate = started?.event.sample_rate ?? 16000;
  const frameMs = started?.event.frame_ms ?? 50;
  const frameSamples = Math.round((sampleRate * frameMs) / 1000);
  const expectedSources = opts.sources ?? started?.event.sources ?? ['mic', 'system'];

  const perSource = {};
  for (const name of expectedSources) perSource[name] = { frames: 0, bytes: 0, firstUs: null, lastUs: null };

  for (const f of frames) {
    if (f.kind !== KIND.AUDIO) continue;
    if (f.source === SOURCE.NONE) {
      fail(`audio frame with source none at t_us=${f.tUs}`);
      continue;
    }
    const s = (perSource[f.sourceName] ??= { frames: 0, bytes: 0, firstUs: null, lastUs: null, unexpected: true });
    if (f.payload.length % 2) fail(`${f.sourceName}: odd audio payload length ${f.payload.length}`);
    if (f.payload.length > frameSamples * 2) {
      fail(`${f.sourceName}: frame of ${f.payload.length} bytes exceeds frame_ms=${frameMs}`);
    }
    if (s.lastUs !== null && f.tUs <= s.lastUs) {
      fail(`${f.sourceName}: t_us not strictly increasing (${s.lastUs} → ${f.tUs})`);
    }
    s.firstUs ??= f.tUs;
    s.lastUs = f.tUs;
    s.frames += 1;
    s.bytes += f.payload.length;
  }

  const frameBytes = frameSamples * 2;
  for (const [name, s] of Object.entries(perSource)) {
    s.seconds = s.bytes / 2 / sampleRate;
    if (s.unexpected) fail(`audio for unexpected source ${name}`);
    if (opts.expectSeconds != null) {
      const want = opts.expectSeconds * sampleRate * 2;
      if (Math.abs(s.bytes - want) > frameBytes) {
        fail(`${name}: ${s.bytes} audio bytes, expected ${want} ± ${frameBytes}`);
      }
    }
    if (opts.maxSeconds != null && s.bytes > opts.maxSeconds * sampleRate * 2 + frameBytes) {
      fail(`${name}: ${s.bytes} audio bytes exceeds --max-seconds ${opts.maxSeconds}`);
    }
    if (opts.expectSeconds != null && s.bytes === 0) fail(`${name}: no audio`);
  }

  // overrun events: audio dropped because a consumer fell behind (PROTOCOL.md "Backpressure").
  const droppedSamples = {};
  for (const f of events.filter((e) => e.event?.type === 'overrun')) {
    const ev = f.event;
    if (f.source === SOURCE.NONE) fail(`overrun event without a source at t_us=${f.tUs}`);
    if (!['capture', 'output'].includes(ev.stage)) fail(`overrun event with unknown stage ${ev.stage}`);
    if (!Number.isInteger(ev.dropped_samples) || ev.dropped_samples < 0) fail('overrun event without dropped_samples');
    droppedSamples[f.sourceName] = (droppedSamples[f.sourceName] ?? 0) + (ev.dropped_samples ?? 0);
  }

  for (const f of events.filter((e) => e.event?.type === 'format_changed')) {
    if (f.source === SOURCE.NONE) fail(`format_changed event without a source at t_us=${f.tUs}`);
    if (!(f.event.device_sample_rate > 0)) fail('format_changed event without device_sample_rate');
  }

  const levels = events.filter((f) => f.event?.type === 'level').length;
  const errorEvents = events.filter((f) => f.event?.type === 'error').map((f) => f.event);
  return {
    errors,
    summary: {
      frames: frames.length,
      sampleRate,
      frameMs,
      sources: Object.fromEntries(
        Object.entries(perSource).map(([n, s]) => [
          n,
          {
            frames: s.frames,
            bytes: s.bytes,
            seconds: Number(s.seconds.toFixed(3)),
            droppedSamples: droppedSamples[n] ?? 0,
            firstUs: Number(s.firstUs ?? 0),
            lastUs: Number(s.lastUs ?? 0),
          },
        ]),
      ),
      levelEvents: levels,
      errorEvents,
      stopReason: stopped?.event.reason ?? null,
    },
  };
}

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) usage(`${a} needs a non-negative number`);
      return v;
    };
    if (a === '--expect-seconds') opts.expectSeconds = num();
    else if (a === '--max-seconds') opts.maxSeconds = num();
    else if (a === '--sources') opts.sources = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--json') opts.json = true;
    else usage(`unknown option ${a}`);
  }
  return opts;
}

function usage(msg) {
  process.stderr.write(`check-frames: ${msg}\nusage: ... | node check-frames.mjs [--expect-seconds s] [--max-seconds s] [--sources mic,system] [--json]\n`);
  process.exit(2);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const parser = new FrameParser();
  const frames = [];
  try {
    for await (const chunk of process.stdin) frames.push(...parser.push(chunk));
  } catch (e) {
    process.stderr.write(`check-frames: FAIL: ${e.message}\n`);
    process.exit(1);
  }
  const { errors, summary } = validateFrames(frames, { ...opts, trailingBytes: parser.pending });
  if (opts.json) process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors, summary }, null, 2) + '\n');
  else {
    const src = Object.entries(summary.sources)
      .map(([n, s]) => `${n}: ${s.frames} frames, ${s.bytes} bytes (${s.seconds}s)${s.droppedSamples ? `, ${s.droppedSamples} samples dropped (overrun)` : ''}`)
      .join('; ');
    process.stdout.write(`frames=${summary.frames} ${src}; level events=${summary.levelEvents}; stop reason=${summary.stopReason}\n`);
    for (const e of errors) process.stderr.write(`check-frames: FAIL: ${e}\n`);
    process.stdout.write(errors.length ? `FAIL (${errors.length} problems)\n` : 'OK\n');
  }
  process.exit(errors.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
