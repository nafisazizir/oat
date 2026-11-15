import type { AudioFrame } from '@oat/audio';

const frameEndUs = (f: AudioFrame) => f.tUs + (f.pcm.length / f.sampleRate) * 1_000_000;

/**
 * Rolling per-stream audio buffer (D-17): keeps at least `capacityMs` of the most recent audio so a new
 * connection can be re-fed everything the provider had not finalized when the old one dropped. Frames are
 * immutable (`@oat/audio` contract), so they are kept by reference.
 */
export class ReplayBuffer {
  readonly capacityMs: number;
  #frames: AudioFrame[] = [];
  #head = 0;
  #heldMs = 0;
  #evictedEndUs: number | undefined;

  constructor(capacityMs: number) {
    if (!(capacityMs > 0)) throw new RangeError('replay capacity must be positive');
    this.capacityMs = capacityMs;
  }

  /** Audio held, in ms (sum of frame durations; gaps between frames don't count). */
  get heldMs(): number {
    return this.#heldMs;
  }

  get size(): number {
    return this.#frames.length - this.#head;
  }

  /** `tUs` of the oldest frame held, or `undefined` when empty. */
  get firstUs(): number | undefined {
    return this.#frames[this.#head]?.tUs;
  }

  /** End (recording µs) of the newest frame evicted so far, or `undefined` if none was. */
  get evictedEndUs(): number | undefined {
    return this.#evictedEndUs;
  }

  /** Appends a frame; evicts the oldest frames that are not needed to keep `capacityMs`. */
  push(frame: AudioFrame): void {
    this.#frames.push(frame);
    this.#heldMs += durationMs(frame);
    while (this.size > 1) {
      const oldest = this.#frames[this.#head]!;
      const d = durationMs(oldest);
      if (this.#heldMs - d < this.capacityMs) break;
      this.#heldMs -= d;
      this.#evictedEndUs = frameEndUs(oldest);
      this.#frames[this.#head++] = undefined as unknown as AudioFrame; // release for GC
    }
    if (this.#head > 1024 && this.#head * 2 > this.#frames.length) {
      this.#frames = this.#frames.slice(this.#head);
      this.#head = 0;
    }
  }

  /** Frames that end after `tUs` (the frame containing `tUs` included), oldest first. */
  from(tUs: number): AudioFrame[] {
    // Binary search on start time (strictly increasing per source).
    let lo = this.#head;
    let hi = this.#frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frameEndUs(this.#frames[mid]!) <= tUs) lo = mid + 1;
      else hi = mid;
    }
    return this.#frames.slice(lo);
  }

  clear(): void {
    this.#frames = [];
    this.#head = 0;
    this.#heldMs = 0;
    this.#evictedEndUs = undefined;
  }
}

function durationMs(frame: AudioFrame): number {
  return (frame.pcm.length / frame.sampleRate) * 1000;
}

/**
 * Maps the provider's socket clock (seconds of audio received on this connection, starting at 0) back to
 * the recording clock (frame `tUs`). Usually one anchor — socket 0 = first frame sent — but frames are not
 * contiguous across a pause or dropped audio, so a new anchor is added at every discontinuity.
 */
export class SocketTimeline {
  readonly sampleRate: number;
  /** Socket sample index → recording µs at that sample, at each discontinuity. */
  readonly #anchors: { sample: number; tUs: number }[] = [];
  #sentSamples = 0;
  #expectedUs: number | undefined;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** Recording µs of the first sample sent, or `undefined` before any. */
  get originUs(): number | undefined {
    return this.#anchors[0]?.tUs;
  }

  /** Record a frame as sent on the socket (in order). */
  append(frame: AudioFrame): void {
    const tolUs = 1_000_000 / this.sampleRate; // one sample
    if (this.#expectedUs === undefined || Math.abs(frame.tUs - this.#expectedUs) > tolUs) {
      this.#anchors.push({ sample: this.#sentSamples, tUs: frame.tUs });
    }
    this.#sentSamples += frame.pcm.length;
    this.#expectedUs = frameEndUs(frame);
  }

  /** Socket seconds → recording ms. Before the first frame, socket 0 = recording 0. */
  toRecordingMs(socketSeconds: number): number {
    const sample = socketSeconds * this.sampleRate;
    let lo = 0;
    let hi = this.#anchors.length - 1;
    if (hi < 0) return socketSeconds * 1000;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.#anchors[mid]!.sample <= sample) lo = mid;
      else hi = mid - 1;
    }
    const a = this.#anchors[lo]!;
    return (a.tUs + ((sample - a.sample) / this.sampleRate) * 1_000_000) / 1000;
  }
}
