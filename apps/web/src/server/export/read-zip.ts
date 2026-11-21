import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Reads back an archive made by `ZipWriter` — for tests (unit, int and e2e) that check what an export
 * holds. Walks the central directory, inflates each entry and verifies its size and CRC. Not a general
 * ZIP reader (no ZIP64, no encryption, stored/deflated entries only).
 */
export type ZipFile = { name: string; text: string; modifiedAt: Date };

export function readZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error('not a zip archive');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`bad local header: ${name}`);
    const localName = decoder.decode(
      bytes.subarray(offset + 30, offset + 30 + view.getUint16(offset + 26, true)),
    );
    if (localName !== name) throw new Error(`local header names another file: ${name}`);
    const start =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (data.length !== size) throw new Error(`wrong size: ${name}`);
    if (crc32(data) !== crc) throw new Error(`wrong checksum: ${name}`);
    files.push({
      name,
      text: decoder.decode(data),
      modifiedAt: new Date(
        Date.UTC(
          (date >> 9) + 1980,
          ((date >> 5) & 15) - 1,
          date & 31,
          time >> 11,
          (time >> 5) & 63,
          (time & 31) * 2,
        ),
      ),
    });
  }
  return files;
}

/** A whole stream as one byte array. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
