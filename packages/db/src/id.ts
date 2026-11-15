/**
 * ID and token generation.
 *
 * IDs are UUIDv7 strings stored in `text` columns (see task 1.5 design notes):
 * - time-ordered, so B-tree inserts stay append-mostly and ids sort roughly by creation;
 * - generated in application code (server, desktop, Better Auth via `advanced.database.generateId`), so the
 *   desktop can create rows offline and `transcript_segment` ids can be client-generated and stable (D-19);
 * - `text`, not `uuid`, because the contract (`@oat/core`) treats ids as opaque strings and some ids are not
 *   ours (client segment ids, any ids Better Auth may generate).
 *
 * Pure: no Node-only APIs (Web Crypto only), so the desktop renderer can import `@oat/db/id` too.
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** A new UUIDv7 (RFC 9562): 48-bit unix ms timestamp, version 7, variant 10, 74 random bits. */
export function newId(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // 48-bit big-endian millisecond timestamp. Split to avoid 32-bit bitwise truncation.
  const hi = Math.floor(now / 2 ** 32);
  const lo = now >>> 0;
  b[0] = (hi >>> 8) & 0xff;
  b[1] = hi & 0xff;
  b[2] = (lo >>> 24) & 0xff;
  b[3] = (lo >>> 16) & 0xff;
  b[4] = (lo >>> 8) & 0xff;
  b[5] = lo & 0xff;
  b[6] = 0x70 | (b[6]! & 0x0f); // version 7
  b[8] = 0x80 | (b[8]! & 0x3f); // variant 10
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += HEX[b[i]!];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Millisecond timestamp encoded in a UUIDv7. */
export function idTimestamp(id: string): number {
  if (!UUID_V7.test(id)) throw new Error(`not a UUIDv7: ${id}`);
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/**
 * A random URL-safe secret: `bytes` random bytes as base64url without padding. The default (24 bytes →
 * 32 chars, 192 bits) satisfies the share-token contract in `@oat/core` (≥ 22 base64url chars).
 */
export function newToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
