/** Stateful box resampler: channel averaging and fractional sample windows span worklet blocks. */
export class PcmConverter {
  #sum = 0;
  #weight = 0;
  readonly #ratio: number;
  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0)
      throw new RangeError('Invalid sample rate');
    this.#ratio = sampleRate / 16000;
  }
  push(channels: readonly Float32Array[]): Int16Array {
    const output: number[] = [];
    for (let i = 0; i < (channels[0]?.length ?? 0); i++) {
      const value = channels.reduce((sum, channel) => sum + (channel[i] ?? 0), 0) / channels.length;
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.#ratio - this.#weight);
        this.#sum += value * take;
        this.#weight += take;
        remaining -= take;
        if (this.#weight >= this.#ratio - 1e-9) {
          const sample = Math.max(-1, Math.min(1, this.#sum / this.#ratio));
          output.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
          this.#sum = this.#weight = 0;
        }
      }
    }
    return Int16Array.from(output);
  }
}

export function pcmWorkletModule(): string {
  return `const PcmConverter = ${PcmConverter.toString()};
registerProcessor('oat-pcm', class extends AudioWorkletProcessor {
  constructor() { super(); this.converter = new PcmConverter(sampleRate); this.pending = []; this.first = null; this.sent = 0; }
  process(inputs) {
    if (!inputs[0]?.length) return true;
    if (this.first === null) this.first = currentTime;
    const pcm = this.converter.push(inputs[0]);
    for (const sample of pcm) this.pending.push(sample);
    while (this.pending.length >= 320) {
      const pcm = Int16Array.from(this.pending.splice(0, 320));
      const tUs = Math.round((this.first + this.sent / 16000) * 1000000);
      this.sent += pcm.length;
      this.port.postMessage({ pcm, tUs }, [pcm.buffer]);
    }
    return true;
  }
});`;
}
