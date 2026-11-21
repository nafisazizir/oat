import { crc32, deflateRawSync } from 'node:zlib';

/*
 * A minimal ZIP writer for "Export my notes" (D-36): text files, written one at a time so the archive
 * can be streamed while the notes are still being read. No dependency, no ZIP64 — the caller bounds the
 * export far below the format's classic limits (65 535 entries, 4 GiB), and `add` refuses beyond them.
 *
 * Each file is deflated in memory (a note is at most a few MB), so its size and CRC are known before its
 * header is written; no data descriptors. Names are stored as UTF-8 (general-purpose bit 11).
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const VERSION = 20;

export const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_OFFSET = 0xffffffff;

type Entry = {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

/** MS-DOS time and date (2-second resolution, years 1980–2107), in UTC. */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export class ZipWriter {
  readonly #entries: Entry[] = [];
  #offset = 0;
  #finished = false;

  /** Bytes written so far (headers and data). */
  get size(): number {
    return this.#offset;
  }

  /**
   * One file. Returns the bytes to send now (local header + compressed data). `name` is stored as given:
   * the caller makes it safe (`export/names.ts`); a name that could leave the folder is refused here too.
   */
  add(name: string, content: string | Uint8Array, modifiedAt: Date = new Date()): Uint8Array {
    if (this.#finished) throw new Error('zip: already finished');
    if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('zip: unsafe entry name');
    }
    if (name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('zip: unsafe entry name');
    }
    if (this.#entries.length >= ZIP_MAX_ENTRIES) throw new Error('zip: too many entries');

    const nameBytes = new TextEncoder().encode(name);
    if (nameBytes.length > 0xffff) throw new Error('zip: entry name too long');
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const compressed = deflateRawSync(data);
    const { time, date } = dosDateTime(modifiedAt);
    const entry: Entry = {
      name: nameBytes,
      crc: crc32(data),
      compressedSize: compressed.length,
      size: data.length,
      offset: this.#offset,
      time,
      date,
    };

    const out = new Uint8Array(30 + nameBytes.length + compressed.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, UTF8_NAMES, true);
    view.setUint16(8, DEFLATE, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.compressedSize, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    out.set(nameBytes, 30);
    out.set(compressed, 30 + nameBytes.length);

    if (this.#offset + out.length > ZIP_MAX_OFFSET) throw new Error('zip: archive too large');
    this.#entries.push(entry);
    this.#offset += out.length;
    return out;
  }

  /** The central directory and end record: the last bytes of the archive. */
  finish(): Uint8Array {
    if (this.#finished) throw new Error('zip: already finished');
    this.#finished = true;
    const directorySize = this.#entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const out = new Uint8Array(directorySize + 22);
    const view = new DataView(out.buffer);
    let at = 0;
    for (const entry of this.#entries) {
      view.setUint32(at, CENTRAL_HEADER, true);
      view.setUint16(at + 4, VERSION, true);
      view.setUint16(at + 6, VERSION, true);
      view.setUint16(at + 8, UTF8_NAMES, true);
      view.setUint16(at + 10, DEFLATE, true);
      view.setUint16(at + 12, entry.time, true);
      view.setUint16(at + 14, entry.date, true);
      view.setUint32(at + 16, entry.crc, true);
      view.setUint32(at + 20, entry.compressedSize, true);
      view.setUint32(at + 24, entry.size, true);
      view.setUint16(at + 28, entry.name.length, true);
      // extra, comment, disk, internal attrs (2 bytes each), external attrs (4): all zero.
      view.setUint32(at + 42, entry.offset, true);
      out.set(entry.name, at + 46);
      at += 46 + entry.name.length;
    }
    view.setUint32(at, END_OF_CENTRAL, true);
    view.setUint16(at + 8, this.#entries.length, true);
    view.setUint16(at + 10, this.#entries.length, true);
    view.setUint32(at + 12, directorySize, true);
    view.setUint32(at + 16, this.#offset, true);
    this.#offset += out.length;
    return out;
  }
}
