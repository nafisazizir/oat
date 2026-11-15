/**
 * Ogg encapsulation of Opus (RFC 7845): the `OpusHead` identification header and `OpusTags` comment header,
 * plus the granule-position arithmetic. Pure TS.
 *
 * Granule positions are always counted in 48 kHz samples regardless of the input rate, and include the
 * encoder's pre-skip: playback time of a granule `g` is `(g − preSkip) / 48000` seconds.
 */

export const OPUS_GRANULE_RATE = 48_000;
/** Sample rates libopus encodes natively. */
export const OPUS_SAMPLE_RATES = [8000, 12_000, 16_000, 24_000, 48_000] as const;
export type OpusSampleRate = (typeof OPUS_SAMPLE_RATES)[number];

export function isOpusSampleRate(rate: number): rate is OpusSampleRate {
  return (OPUS_SAMPLE_RATES as readonly number[]).includes(rate);
}

export interface OpusHead {
  readonly channels: number;
  /** Samples at 48 kHz to discard from the start of the decoded stream (encoder lookahead). */
  readonly preSkip: number;
  /** The original input rate (informational; decoders may output any Opus rate). */
  readonly inputSampleRate: number;
  /** Q7.8 dB. */
  readonly outputGain: number;
  readonly mappingFamily: number;
}

const HEAD_MAGIC = 'OpusHead';
const TAGS_MAGIC = 'OpusTags';

export function buildOpusHead(head: Omit<OpusHead, 'outputGain' | 'mappingFamily'>): Uint8Array {
  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set(ascii(HEAD_MAGIC), 0);
  out[8] = 1; // version
  out[9] = head.channels;
  view.setUint16(10, head.preSkip, true);
  view.setUint32(12, head.inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  out[18] = 0; // channel mapping family 0: mono/stereo, no table
  return out;
}

export function parseOpusHead(packet: Uint8Array): OpusHead {
  if (packet.length < 19 || !startsWith(packet, HEAD_MAGIC))
    throw new Error('not an OpusHead packet');
  const version = packet[8] as number;
  if (version >> 4 !== 0) throw new Error(`unsupported OpusHead version ${version}`);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    channels: packet[9] as number,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
    mappingFamily: packet[18] as number,
  };
}

export interface OpusTags {
  readonly vendor: string;
  /** `KEY=value` pairs (keys are case-insensitive per Vorbis comment rules; we keep them upper case). */
  readonly comments: Readonly<Record<string, string>>;
}

export function buildOpusTags(tags: OpusTags): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode(tags.vendor);
  const comments = Object.entries(tags.comments).map(([k, v]) => enc.encode(`${k}=${v}`));
  const size = 8 + 4 + vendor.length + 4 + comments.reduce((n, c) => n + 4 + c.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(ascii(TAGS_MAGIC), 0);
  let o = 8;
  view.setUint32(o, vendor.length, true);
  out.set(vendor, (o += 4));
  o += vendor.length;
  view.setUint32(o, comments.length, true);
  o += 4;
  for (const c of comments) {
    view.setUint32(o, c.length, true);
    out.set(c, (o += 4));
    o += c.length;
  }
  return out;
}

export function parseOpusTags(packet: Uint8Array): OpusTags {
  if (!startsWith(packet, TAGS_MAGIC)) throw new Error('not an OpusTags packet');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const dec = new TextDecoder();
  let o = 8;
  const read = (): string => {
    const n = view.getUint32(o, true);
    o += 4;
    if (o + n > packet.length) throw new Error('truncated OpusTags');
    const s = dec.decode(packet.subarray(o, o + n));
    o += n;
    return s;
  };
  const vendor = read();
  const count = view.getUint32(o, true);
  o += 4;
  const comments: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const c = read();
    const eq = c.indexOf('=');
    if (eq > 0) comments[c.slice(0, eq).toUpperCase()] = c.slice(eq + 1);
  }
  return { vendor, comments };
}

/**
 * Duration of an Opus packet in 48 kHz samples, from its TOC byte (RFC 6716 §3.1). Returns 0 for an empty
 * or malformed packet.
 */
export function opusPacketSamples48k(packet: Uint8Array): number {
  if (packet.length < 1) return 0;
  const toc = packet[0] as number;
  const config = toc >> 3;
  let frame: number; // 48 kHz samples per frame
  if (config < 12)
    frame = [480, 960, 1920, 2880][config & 3] as number; // SILK 10/20/40/60 ms
  else if (config < 16)
    frame = config & 1 ? 960 : 480; // hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config & 3] as number; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 3) {
    if (packet.length < 2) return 0;
    frames = (packet[1] as number) & 0x3f;
  } else frames = 2;
  return frames * frame;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}
