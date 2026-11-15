import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './client.ts';
import { SYNCED_TABLES } from './schema/index.ts';
import { decodeCursor, encodeCursor } from './sync.ts';

describe('change cursor', () => {
  it('round-trips (txid, seq)', () => {
    const cursor = encodeCursor({ txid: '18446744073709551615', seq: 42 });
    expect(cursor).toBe('18446744073709551615.42');
    expect(decodeCursor(cursor)).toEqual({ txid: '18446744073709551615', seq: '42' });
  });

  it.each(['', '1', '1.', '.1', 'a.1', '1.1;drop table x', '1.2.3'])('rejects %j', (bad) => {
    expect(() => decodeCursor(bad)).toThrow(/cursor/);
  });
});

describe('change_log trigger migration', () => {
  it('has a trigger for exactly SYNCED_TABLES', () => {
    const sql = readFileSync(`${MIGRATIONS_FOLDER}/0002_change_log_triggers.sql`, 'utf8');
    const triggered = [...sql.matchAll(/CREATE TRIGGER \w+ AFTER .* ON public\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(triggered.sort()).toEqual([...SYNCED_TABLES].sort());
  });
});
