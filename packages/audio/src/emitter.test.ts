import { afterEach, describe, expect, it, vi } from 'vitest';

import { Fanout } from './emitter.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Fanout', () => {
  it('delivers to every listener in order and supports independent unsubscribe', () => {
    const fanout = new Fanout<number>();
    const seen: string[] = [];
    const listener = (v: number) => seen.push(`x${v}`);
    const offA = fanout.add(listener);
    fanout.add(listener); // same function twice = two subscriptions
    fanout.add((v) => seen.push(`y${v}`));
    fanout.emit(1);
    offA();
    offA(); // idempotent
    fanout.emit(2);
    expect(seen).toEqual(['x1', 'x1', 'y1', 'x2', 'y2']);
    expect(fanout.size).toBe(2);
  });

  it('a throwing listener does not starve the others; its error goes to onError, nothing escapes', () => {
    const queued = vi.fn();
    vi.stubGlobal('queueMicrotask', queued);
    const errors: [unknown, number][] = [];
    const fanout = new Fanout<number>((error, value) => errors.push([error, value]));
    const seen: number[] = [];
    fanout.add(() => {
      throw new Error('boom');
    });
    fanout.add((v) => seen.push(v));
    expect(() => fanout.emit(7)).not.toThrow();
    expect(seen).toEqual([7]);
    expect(errors).toEqual([[new Error('boom'), 7]]);
    expect(queued).not.toHaveBeenCalled(); // no deferred re-throw → no uncaughtException
  });

  it('defaults to console.error, and survives a throwing onError', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fanout = new Fanout<number>();
      fanout.add(() => {
        throw new Error('first');
      });
      fanout.emit(1);
      expect(consoleError).toHaveBeenCalledWith('[@oat/audio] listener threw:', new Error('first'));

      const seen: number[] = [];
      const strict = new Fanout<number>(() => {
        throw new Error('handler broke');
      });
      strict.add(() => {
        throw new Error('second');
      });
      strict.add((v) => seen.push(v));
      expect(() => strict.emit(2)).not.toThrow();
      expect(seen).toEqual([2]);
      expect(consoleError).toHaveBeenLastCalledWith(
        '[@oat/audio] listener threw:',
        new Error('handler broke'),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a listener added during emit only sees later values', () => {
    const fanout = new Fanout<number>();
    const seen: number[] = [];
    fanout.add(() => {
      if (fanout.size === 1) fanout.add((v) => seen.push(v));
    });
    fanout.emit(1);
    fanout.emit(2);
    expect(seen).toEqual([2]);
  });
});
