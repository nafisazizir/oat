/**
 * Minimal Ogg bitstream framing (RFC 3533) for the local audio archive (task 2.8, D-10): build pages from
 * whole packets, parse pages back with CRC checks, reassemble packets. Pure TS, no Node APIs.
 *
 * Page layout (all integers little-endian):
 * ```
 *  0  "OggS"            capture pattern
 *  4  u8   version      0
 *  5  u8   flags        1 = continued packet, 2 = beginning of stream, 4 = end of stream
 *  6  i64  granule      codec-defined position after the last packet that *ends* on this page (−1: none)
 * 14  u32  serial       logical stream id
 * 18  u32  sequence     page counter
 * 22  u32  crc          CRC-32 (poly 0x04C11DB7, init 0, unreflected) over the page with this field zeroed
 * 26  u8   segments     number of lacing values (≤ 255)
 * 27  u8[] lacing       a packet is a run of 255s ended by a value < 255
 *     body
 * ```
 */

export const OGG_CONTINUED = 0x01;
export const OGG_BOS = 0x02;
export const OGG_EOS = 0x04;

export const OGG_HEADER_SIZE = 27;
export const OGG_MAX_SEGMENTS = 255;
/** Granule value meaning "no packet ends on this page". */
export const OGG_NO_GRANULE = -1;

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04C11DB7, initial value 0, no reflection, no final xor. */
export function oggCrc32(bytes: Uint8Array, crc = 0): number {
  let r = crc >>> 0;
  for (const byte of bytes)
    r = ((r << 8) ^ (CRC_TABLE[((r >>> 24) ^ byte) & 0xff] as number)) >>> 0;
  return r;
}

/** Lacing values for one packet: ⌊len/255⌋ × 255, then len mod 255 (a 0 when len is a multiple of 255). */
export function lacingFor(length: number): number[] {
  const values = Array<number>(Math.floor(length / 255)).fill(255);
  values.push(length % 255);
  return values;
}

export interface OggPageInput {
  readonly flags?: number;
  /** Position after the last packet on the page; `OGG_NO_GRANULE` if none ends here. */
  readonly granule: number;
  readonly serial: number;
  readonly sequence: number;
  /** Whole packets only (this writer never splits a packet across pages). */
  readonly packets: readonly Uint8Array[];
}

/** Serialises one page. Throws if the packets need more than 255 lacing values. */
export function buildOggPage(input: OggPageInput): Uint8Array {
  const lacing: number[] = [];
  let bodySize = 0;
  for (const packet of input.packets) {
    lacing.push(...lacingFor(packet.length));
    bodySize += packet.length;
  }
  if (lacing.length > OGG_MAX_SEGMENTS) {
    throw new RangeError(`page needs ${lacing.length} lacing values (max ${OGG_MAX_SEGMENTS})`);
  }
  const page = new Uint8Array(OGG_HEADER_SIZE + lacing.length + bodySize);
  const view = new DataView(page.buffer);
  page.set(CAPTURE, 0);
  page[4] = 0;
  page[5] = input.flags ?? 0;
  view.setBigInt64(6, BigInt(input.granule), true);
  view.setUint32(14, input.serial >>> 0, true);
  view.setUint32(18, input.sequence >>> 0, true);
  page[26] = lacing.length;
  page.set(lacing, OGG_HEADER_SIZE);
  let offset = OGG_HEADER_SIZE + lacing.length;
  for (const packet of input.packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc32(page), true);
  return page;
}

/** Number of lacing values a page with these packets needs. */
export function segmentCount(packets: readonly Uint8Array[]): number {
  let n = 0;
  for (const p of packets) n += Math.floor(p.length / 255) + 1;
  return n;
}

export interface OggPage {
  /** Byte offset of the page in the parsed buffer. */
  readonly offset: number;
  /** Total page size in bytes (header + lacing + body). */
  readonly size: number;
  readonly flags: number;
  readonly granule: number;
  readonly serial: number;
  readonly sequence: number;
  readonly lacing: Uint8Array;
  readonly body: Uint8Array;
}

/** Bytes skipped between two valid pages (a corrupt or partly overwritten region). */
export interface OggHole {
  readonly offset: number;
  readonly size: number;
  readonly reason: string;
}

export interface OggParseResult {
  /** Every complete, CRC-valid page, in file order. */
  readonly pages: OggPage[];
  /** End offset of the last valid page: bytes after it hold no further valid page (a torn tail). */
  readonly validEnd: number;
  /** Corrupt regions *between* valid pages that were skipped by resynchronising (libogg-style). */
  readonly holes: readonly OggHole[];
  /** Why the bytes after `validEnd` were rejected (absent when every byte was consumed). */
  readonly error?: string;
}

type PageAttempt = { page: OggPage } | { error: string };

function readPage(bytes: Uint8Array, view: DataView, offset: number): PageAttempt {
  if (bytes.length - offset < OGG_HEADER_SIZE) return { error: 'truncated page header' };
  for (let i = 0; i < 4; i++) {
    if (bytes[offset + i] !== CAPTURE[i]) return { error: `no capture pattern at ${offset}` };
  }
  if (bytes[offset + 4] !== 0) return { error: `unsupported Ogg version at ${offset}` };
  const count = bytes[offset + 26] as number;
  const bodyStart = offset + OGG_HEADER_SIZE + count;
  if (bodyStart > bytes.length) return { error: 'truncated lacing table' };
  const lacing = bytes.subarray(offset + OGG_HEADER_SIZE, bodyStart);
  let bodySize = 0;
  for (const v of lacing) bodySize += v;
  const end = bodyStart + bodySize;
  if (end > bytes.length) return { error: 'truncated page body' };
  const page = bytes.subarray(offset, end);
  // CRC over the page with the CRC field taken as zero.
  let crc = oggCrc32(page.subarray(0, 22));
  crc = oggCrc32(ZERO4, crc);
  crc = oggCrc32(page.subarray(26), crc);
  if (crc !== view.getUint32(offset + 22, true)) return { error: `CRC mismatch at ${offset}` };
  return {
    page: {
      offset,
      size: end - offset,
      flags: bytes[offset + 5] as number,
      granule: Number(view.getBigInt64(offset + 6, true)),
      serial: view.getUint32(offset + 14, true),
      sequence: view.getUint32(offset + 18, true),
      lacing,
      body: bytes.subarray(bodyStart, end),
    },
  };
}

/** Next offset ≥ `from` where "OggS" starts, or -1. */
function findCapture(bytes: Uint8Array, from: number): number {
  for (let i = from; i <= bytes.length - 4; i++) {
    if (
      bytes[i] === 0x4f &&
      bytes[i + 1] === 0x67 &&
      bytes[i + 2] === 0x67 &&
      bytes[i + 3] === 0x53
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Parses every valid page in `bytes`. A corrupt or truncated page does not end parsing: like libogg, the
 * parser resynchronises on the next capture pattern that starts a CRC-valid page and records the skipped
 * bytes as a hole. Only a tail with no further valid page is reported as the end (`validEnd`, `error`).
 * Never throws.
 */
export function parseOggPages(bytes: Uint8Array): OggParseResult {
  const pages: OggPage[] = [];
  const holes: OggHole[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const attempt = readPage(bytes, view, offset);
    if ('page' in attempt) {
      pages.push(attempt.page);
      offset += attempt.page.size;
      continue;
    }
    // Resync: the next capture pattern that starts a valid page.
    let next = findCapture(bytes, offset + 1);
    while (next >= 0 && !('page' in readPage(bytes, view, next)))
      next = findCapture(bytes, next + 1);
    if (next < 0) return { pages, validEnd: offset, holes, error: attempt.error };
    holes.push({ offset, size: next - offset, reason: attempt.error });
    offset = next;
  }
  return { pages, validEnd: offset, holes };
}

const ZERO4 = new Uint8Array(4);

/** Rewrites a page's flags in place (e.g. to add `OGG_EOS` during recovery) and fixes its CRC. */
export function setPageFlags(page: Uint8Array, flags: number): void {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  page[5] = flags;
  view.setUint32(22, 0, true);
  view.setUint32(22, oggCrc32(page), true);
}

export interface OggPacket {
  readonly data: Uint8Array;
  /** Index into `pages` of the page the packet ends on. */
  readonly pageIndex: number;
  /** Whether it is the last packet ending on that page (its end position = that page's granule). */
  readonly lastOnPage: boolean;
}

/**
 * Reassembles packets from parsed pages (of one logical stream), starting at `fromPage`. A packet left
 * unfinished at the end of the last page is dropped; a continuation at `fromPage` is skipped.
 */
export function* oggPackets(pages: readonly OggPage[], fromPage = 0): Generator<OggPacket> {
  let parts: Uint8Array[] = [];
  let skipping = (pages[fromPage]?.flags ?? 0) & OGG_CONTINUED;
  for (let p = fromPage; p < pages.length; p++) {
    const page = pages[p] as OggPage;
    if (p > fromPage && !(page.flags & OGG_CONTINUED) && parts.length > 0) parts = []; // lost continuation
    // Indices of lacing values that end a packet, to know which packet is last on the page.
    let lastEnd = -1;
    for (let i = 0; i < page.lacing.length; i++) if ((page.lacing[i] as number) < 255) lastEnd = i;
    let pos = 0;
    let start = 0;
    for (let i = 0; i < page.lacing.length; i++) {
      const v = page.lacing[i] as number;
      pos += v;
      if (v < 255) {
        const piece = page.body.subarray(start, pos);
        start = pos;
        if (skipping) {
          skipping = 0;
          parts = [];
          continue;
        }
        parts.push(piece);
        yield { data: concat(parts), pageIndex: p, lastOnPage: i === lastEnd };
        parts = [];
      }
    }
    if (start < pos && !skipping) parts.push(page.body.subarray(start, pos));
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
