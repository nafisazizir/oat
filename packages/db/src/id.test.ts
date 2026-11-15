import { MIN_SHARE_TOKEN_LENGTH } from '@oat/core';
import { describe, expect, it } from 'vitest';
import { idTimestamp, newId, newToken, UUID_V7 } from './id.ts';

describe('newId', () => {
  it('returns UUIDv7 strings encoding the creation time', () => {
    const now = Date.UTC(2026, 10, 14, 12, 0, 0, 123);
    const id = newId(now);
    expect(id).toMatch(UUID_V7);
    expect(idTimestamp(id)).toBe(now);
  });

  it('handles timestamps beyond 32 bits and the 48-bit maximum', () => {
    const max = 2 ** 48 - 1;
    expect(idTimestamp(newId(max))).toBe(max);
    expect(idTimestamp(newId(0))).toBe(0);
  });

  it('is unique and sorts by creation time across milliseconds', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => newId(1_700_000_000_000 + i));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects non-v7 ids in idTimestamp', () => {
    expect(() => idTimestamp('not-an-id')).toThrow(/UUIDv7/);
  });
});

describe('newToken', () => {
  it('is base64url and long enough to be a share token', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).toHaveLength(32);
    expect(token.length).toBeGreaterThanOrEqual(MIN_SHARE_TOKEN_LENGTH);
    expect(newToken(16)).toHaveLength(22);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newToken()));
    expect(tokens.size).toBe(1000);
  });
});
