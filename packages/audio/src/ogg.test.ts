import { describe, expect, it } from 'vitest';

import {
  buildOggPage,
  lacingFor,
  OGG_BOS,
  OGG_CONTINUED,
  OGG_EOS,
  OGG_NO_GRANULE,
  oggCrc32,
  oggPackets,
  parseOggPages,
  setPageFlags,
} from './ogg.ts';
import {
  buildOpusHead,
  buildOpusTags,
  opusPacketSamples48k,
  parseOpusHead,
  parseOpusTags,
} from './ogg-opus.ts';

const bytes = (n: number, seed = 1) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('Ogg framing (RFC 3533)', () => {
  it('uses the Ogg CRC-32 (poly 0x04C11DB7, init 0, unreflected)', () => {
    // Check value of this CRC variant for "123456789" (CRC-32/POSIX without the final inversion).
    expect(oggCrc32(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
  });

  it('laces packets, including exact multiples of 255 (trailing 0) and empty packets', () => {
    expect(lacingFor(0)).toEqual([0]);
    expect(lacingFor(254)).toEqual([254]);
    expect(lacingFor(255)).toEqual([255, 0]);
    expect(lacingFor(600)).toEqual([255, 255, 90]);
  });

  it('round-trips pages and packets', () => {
    const packets = [bytes(10), bytes(255, 2), bytes(0), bytes(700, 3)];
    const page = buildOggPage({
      flags: OGG_BOS,
      granule: 123_456_789_012,
      serial: 0xdeadbeef,
      sequence: 7,
      packets,
    });
    expect(String.fromCharCode(...page.subarray(0, 4))).toBe('OggS');
    const { pages, validEnd, error } = parseOggPages(page);
    expect(error).toBeUndefined();
    expect(validEnd).toBe(page.length);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      flags: OGG_BOS,
      granule: 123_456_789_012,
      serial: 0xdeadbeef,
      sequence: 7,
    });
    const out = [...oggPackets(pages)];
    expect(out.map((p) => [...p.data])).toEqual(packets.map((p) => [...p]));
    expect(out.map((p) => p.lastOnPage)).toEqual([false, false, false, true]);
  });

  it('refuses a page that needs more than 255 lacing values', () => {
    expect(() =>
      buildOggPage({
        granule: 0,
        serial: 1,
        sequence: 0,
        packets: Array.from({ length: 256 }, () => bytes(1)),
      }),
    ).toThrow(RangeError);
  });

  it('reassembles a packet continued across pages and skips a leading continuation', () => {
    // Hand-built pages: a 300-byte packet split 255 | 45 across two pages, then a short one.
    const big = bytes(300, 9);
    const small = bytes(5, 4);
    const p0 = rawPage(0, OGG_NO_GRANULE, 0, [255], big.subarray(0, 255));
    const p1 = rawPage(OGG_CONTINUED, 960, 1, [45, 5], concat(big.subarray(255), small));
    const { pages } = parseOggPages(concat(p0, p1));
    expect([...oggPackets(pages)].map((p) => p.data.length)).toEqual([300, 5]);
    // Starting at the continued page drops the fragment.
    expect([...oggPackets(pages, 1)].map((p) => [...p.data])).toEqual([[...small]]);
  });

  it('stops at a torn or corrupt page and reports how far the data is valid', () => {
    const a = buildOggPage({ granule: 0, serial: 1, sequence: 0, packets: [bytes(50)] });
    const b = buildOggPage({ granule: 960, serial: 1, sequence: 1, packets: [bytes(80)] });
    const all = concat(a, b);
    for (let cut = a.length; cut < all.length; cut++) {
      const r = parseOggPages(all.subarray(0, cut));
      expect(r.pages).toHaveLength(1);
      expect(r.validEnd).toBe(a.length);
      if (cut > a.length) expect(r.error).toMatch(/truncated/);
    }
    const corrupt = Uint8Array.from(all);
    corrupt[a.length + 40] = (corrupt[a.length + 40] as number) ^ 0xff;
    const r = parseOggPages(corrupt);
    expect(r.pages).toHaveLength(1);
    expect(r.error).toMatch(/CRC/);
  });

  it('resyncs past a corrupt middle page (and garbage) to the next valid page, recording the hole', () => {
    const page = (seq: number) =>
      buildOggPage({ granule: seq * 960, serial: 1, sequence: seq, packets: [bytes(60, seq)] });
    const [a, b, c] = [page(0), page(1), page(2)];
    const bad = Uint8Array.from(b);
    bad[40] = (bad[40] as number) ^ 0xff;
    const garbage = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 9, 9, 9); // a false capture pattern
    const r = parseOggPages(concat(a, bad, garbage, c));
    expect(r.pages.map((p) => p.sequence)).toEqual([0, 2]);
    expect(r.holes).toEqual([
      { offset: a.length, size: bad.length + garbage.length, reason: expect.stringMatching(/CRC/) },
    ]);
    expect(r.validEnd).toBe(a.length + bad.length + garbage.length + c.length);
    expect(r.error).toBeUndefined();
  });

  it('setPageFlags rewrites the CRC', () => {
    const page = buildOggPage({ granule: 960, serial: 1, sequence: 3, packets: [bytes(20)] });
    setPageFlags(page, OGG_EOS);
    const { pages, error } = parseOggPages(page);
    expect(error).toBeUndefined();
    expect(pages[0]?.flags).toBe(OGG_EOS);
  });
});

describe('Ogg Opus headers (RFC 7845)', () => {
  it('round-trips OpusHead', () => {
    const head = buildOpusHead({ channels: 1, preSkip: 312, inputSampleRate: 16_000 });
    expect(head).toHaveLength(19);
    expect(parseOpusHead(head)).toEqual({
      channels: 1,
      preSkip: 312,
      inputSampleRate: 16_000,
      outputGain: 0,
      mappingFamily: 0,
    });
    expect(() => parseOpusHead(bytes(19))).toThrow(/OpusHead/);
  });

  it('round-trips OpusTags with UTF-8 comments', () => {
    const tags = {
      vendor: 'oat-audio (libopus x)',
      comments: { OAT_SOURCE: 'mic', TITLE: 'Réunion ✓' },
    };
    expect(parseOpusTags(buildOpusTags(tags))).toEqual(tags);
  });

  it('reads packet durations from the TOC byte', () => {
    expect(opusPacketSamples48k(Uint8Array.of(0x48))).toBe(960); // SILK WB 20 ms, one frame
    expect(opusPacketSamples48k(Uint8Array.of(0xf8))).toBe(960); // CELT FB 20 ms
    expect(opusPacketSamples48k(Uint8Array.of(0xf9, 0))).toBe(1920); // code 1: two frames
    expect(opusPacketSamples48k(Uint8Array.of(0x4b, 0x03))).toBe(2880); // code 3: three 20 ms frames
    expect(opusPacketSamples48k(new Uint8Array(0))).toBe(0);
  });
});

/** A page with an explicit lacing table (to build continued packets the writer never produces). */
function rawPage(
  flags: number,
  granule: number,
  sequence: number,
  lacing: number[],
  body: Uint8Array,
) {
  const page = new Uint8Array(27 + lacing.length + body.length);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[5] = flags;
  view.setBigInt64(6, BigInt(granule), true);
  view.setUint32(14, 1, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  view.setUint32(22, oggCrc32(page), true);
  return page;
}
