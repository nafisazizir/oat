import { describe, expect, it } from 'vitest';
import { RequestLog } from './request-log.ts';

const entry = (provider: string, path = `/${provider}/x`) => ({
  at: new Date(0).toISOString(),
  method: 'GET',
  path,
  provider,
  query: {},
  headers: {},
  body: null,
  status: 200,
});

describe('RequestLog', () => {
  it('assigns increasing ids and lists oldest first', () => {
    const log = new RequestLog(10);
    log.add(entry('a'));
    log.add(entry('b'));
    expect(log.list().map((r) => [r.id, r.provider])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('drops the oldest entries beyond capacity', () => {
    const log = new RequestLog(3);
    for (let i = 0; i < 5; i++) log.add(entry('p', `/p/${i}`));
    expect(log.size).toBe(3);
    expect(log.list().map((r) => r.path)).toEqual(['/p/2', '/p/3', '/p/4']);
  });

  it('filters by provider, since and limit', () => {
    const log = new RequestLog();
    log.add(entry('a'));
    log.add(entry('b'));
    log.add(entry('a'));
    log.add(entry('a'));
    expect(log.list({ provider: 'a' }).map((r) => r.id)).toEqual([1, 3, 4]);
    expect(log.list({ since: 2 }).map((r) => r.id)).toEqual([3, 4]);
    expect(log.list({ provider: 'a', limit: 2 }).map((r) => r.id)).toEqual([3, 4]);
  });

  it('keeps ids monotonic across clear()', () => {
    const log = new RequestLog();
    log.add(entry('a'));
    log.clear();
    expect(log.size).toBe(0);
    expect(log.add(entry('a')).id).toBe(2);
  });

  it('clear(provider) drops only that provider', () => {
    const log = new RequestLog();
    log.add(entry('a'));
    log.add(entry('b'));
    log.add(entry('a'));
    log.clear('a');
    expect(log.list().map((r) => r.provider)).toEqual(['b']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RequestLog(0)).toThrow(RangeError);
  });
});
