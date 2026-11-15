import { describe, expect, it } from 'vitest';

import { NotesFlush } from './notes-flush.ts';

function harness(window = true) {
  const sent: number[] = [];
  let fire: (() => void) | null = null;
  const flush = new NotesFlush({
    send: (id) => {
      if (window) sent.push(id);
      return window;
    },
    setTimer: (fn) => (fire = fn),
    clearTimer: () => (fire = null),
  });
  return { flush, sent, timeout: () => fire?.() };
}

describe('NotesFlush', () => {
  it('resolves when the window answers with the same id', async () => {
    const h = harness();
    const done = h.flush.request();
    expect(h.sent).toEqual([1]);
    h.flush.ack(99); // someone else's answer
    h.flush.ack(1);
    await expect(done).resolves.toBe('flushed');
    h.timeout(); // the timer was cleared: nothing happens
  });

  it('gives up after the timeout so a hung window never blocks quitting', async () => {
    const h = harness();
    const done = h.flush.request();
    h.timeout();
    await expect(done).resolves.toBe('timeout');
    h.flush.ack(1); // late answer: ignored
  });

  it('without a window there is nothing to wait for', async () => {
    await expect(harness(false).flush.request()).resolves.toBe('no-window');
  });

  it('each request has its own id', async () => {
    const h = harness();
    const a = h.flush.request();
    h.flush.ack(1);
    const b = h.flush.request();
    h.flush.ack(2);
    await expect(Promise.all([a, b])).resolves.toEqual(['flushed', 'flushed']);
    expect(h.sent).toEqual([1, 2]);
  });
});
