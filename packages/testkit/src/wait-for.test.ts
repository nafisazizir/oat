import { describe, expect, it } from 'vitest';
import { waitFor } from './wait-for.ts';

describe('waitFor', () => {
  it('returns the first truthy-ish value', async () => {
    let n = 0;
    const value = await waitFor(() => (++n >= 3 ? `done after ${n}` : undefined), { interval: 1 });
    expect(value).toBe('done after 3');
  });

  it('treats 0 and empty string as values, but not null/false/undefined', async () => {
    expect(await waitFor(() => 0)).toBe(0);
    expect(await waitFor(() => '')).toBe('');
    const seq = [null, false, undefined, 'x'];
    expect(await waitFor(() => seq.shift(), { interval: 1 })).toBe('x');
  });

  it('retries through thrown errors', async () => {
    let n = 0;
    const value = await waitFor(
      async () => {
        if (++n < 3) throw new Error('not yet');
        return n;
      },
      { interval: 1 },
    );
    expect(value).toBe(3);
  });

  it('times out with the message and the last error as cause', async () => {
    const err = await waitFor(
      () => {
        throw new Error('still failing');
      },
      { timeout: 30, interval: 5, message: 'never ready' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^never ready after 30ms: still failing$/);
    expect(((err as Error).cause as Error).message).toBe('still failing');
  });

  it('times out when the check keeps returning nothing', async () => {
    await expect(waitFor(() => undefined, { timeout: 20, interval: 5 })).rejects.toThrow(
      /timed out after 20ms$/,
    );
  });
});
