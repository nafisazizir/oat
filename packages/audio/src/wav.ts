/**
 * RIFF/WAVE read + write. Pure TypeScript, no native deps.
 *
 * Reads PCM integer (8/16/24/32-bit) and IEEE float (32/64-bit), plain or WAVE_FORMAT_EXTENSIBLE, skipping
 * unknown chunks (LIST, FLLR padding from afconvert, …). Every input is converted to signed 16-bit per
 * channel, which is what the rest of the audio pipeline uses. Writes 16-bit PCM only.
 */

export interface WavAudio {
  sampleRate: number;
  /** One Int16Array per channel, all the same length. For fixtures: [0] = mic (L), [1] = system (R). */
  channels: Int16Array[];
}

export interface DecodedWav extends WavAudio {
  /** Bits per sample in the source file (before conversion to 16-bit). */
  sourceBitsPerSample: number;
  sourceFormat: 'pcm' | 'float';
}

export class WavError extends Error {
  override name = 'WavError';
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function wavDurationMs(wav: WavAudio): number {
  return ((wav.channels[0]?.length ?? 0) / wav.sampleRate) * 1000;
}

export function decodeWav(input: Uint8Array): DecodedWav {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') {
    throw new WavError('not a RIFF/WAVE file');
  }

  let fmt:
    | { format: number; channels: number; sampleRate: number; blockAlign: number; bits: number }
    | undefined;
  let data: { offset: number; size: number } | undefined;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tag(view, offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    // Streaming writers leave 0 / 0xFFFFFFFF in the data size; clamp to what is actually there.
    const size = Math.min(declared, view.byteLength - body);
    if (id === 'fmt ') {
      if (size < 16) throw new WavError('fmt chunk too short');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE) {
        if (size < 40) throw new WavError('extensible fmt chunk too short');
        format = view.getUint16(body + 24, true); // first two bytes of the SubFormat GUID
      }
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      const openEnded = declared === 0 || declared > view.byteLength - body;
      data = { offset: body, size: openEnded ? view.byteLength - body : size };
      // An open-ended data chunk runs to the end of the file: nothing after it can be a chunk header.
      if (fmt || openEnded) break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new WavError('missing fmt chunk');
  if (!data) throw new WavError('missing data chunk');
  const { format, channels: channelCount, sampleRate, bits } = fmt;
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new WavError(`unsupported WAV format tag ${format}`);
  }
  if (channelCount < 1) throw new WavError('WAV has no channels');
  if (sampleRate < 1) throw new WavError('invalid sample rate');
  const bytesPerSample = bits / 8;
  const supported =
    format === FORMAT_PCM ? [8, 16, 24, 32].includes(bits) : bits === 32 || bits === 64;
  if (!supported) throw new WavError(`unsupported ${bits}-bit ${format === 1 ? 'PCM' : 'float'}`);
  const blockAlign = bytesPerSample * channelCount;

  const frames = Math.floor(data.size / blockAlign);
  const channels = Array.from({ length: channelCount }, () => new Int16Array(frames));
  const read = sampleReader(view, format === FORMAT_FLOAT ? 'float' : 'pcm', bits);
  for (let i = 0; i < frames; i++) {
    const base = data.offset + i * blockAlign;
    for (let c = 0; c < channelCount; c++) {
      (channels[c] as Int16Array)[i] = read(base + c * bytesPerSample);
    }
  }

  return {
    sampleRate,
    channels,
    sourceBitsPerSample: bits,
    sourceFormat: format === FORMAT_FLOAT ? 'float' : 'pcm',
  };
}

export function encodeWav(audio: WavAudio): Uint8Array {
  const { sampleRate, channels } = audio;
  const channelCount = channels.length;
  if (channelCount < 1) throw new WavError('need at least one channel');
  const frames = channels[0]?.length ?? 0;
  if (channels.some((ch) => ch.length !== frames)) {
    throw new WavError('all channels must have the same length');
  }
  const blockAlign = channelCount * 2;
  const dataSize = frames * blockAlign;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(view, 8, 'WAVE');
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeTag(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      view.setInt16(p, (channels[c] as Int16Array)[i] as number, true);
      p += 2;
    }
  }
  return out;
}

function sampleReader(
  view: DataView,
  format: 'pcm' | 'float',
  bits: number,
): (offset: number) => number {
  if (format === 'float') {
    const get =
      bits === 64
        ? (o: number) => view.getFloat64(o, true)
        : (o: number) => view.getFloat32(o, true);
    return (o) => floatToInt16(get(o));
  }
  switch (bits) {
    case 8:
      return (o) => (view.getUint8(o) - 128) << 8;
    case 16:
      return (o) => view.getInt16(o, true);
    case 24:
      return (o) => {
        const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
        return v >> 8;
      };
    default:
      return (o) => view.getInt32(o, true) >> 16;
  }
}

/** Float sample in [-1, 1] → clamped signed 16-bit. NaN → 0. */
export function floatToInt16(x: number): number {
  if (Number.isNaN(x)) return 0;
  const v = Math.round(x * 32768);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v + 0; // `+ 0` turns -0 into 0
}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function writeTag(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
}
