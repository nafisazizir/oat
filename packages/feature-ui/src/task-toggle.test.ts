import { describe, expect, it, vi } from 'vitest';

import { OatApiError } from '@oat/client';

import { setDoneRetryingOnce, toggleFailure } from './task-toggle';

const stale = (version?: number) =>
  new OatApiError(
    409,
    'stale_version',
    'Changed',
    version === undefined ? undefined : ({ document: { version } } as never),
  );

describe('setDoneRetryingOnce', () => {
  it('writes at the loaded version', async () => {
    const setDone = vi.fn().mockResolvedValue({ documentVersion: 4 });
    await expect(setDoneRetryingOnce(setDone, 't1', true, 3)).resolves.toEqual({
      documentVersion: 4,
    });
    expect(setDone).toHaveBeenCalledExactlyOnceWith('t1', { done: true, baseVersion: 3 });
  });

  it('retries once on the server’s version when the note changed', async () => {
    const setDone = vi
      .fn()
      .mockRejectedValueOnce(stale(7))
      .mockResolvedValueOnce({ documentVersion: 8 });
    await expect(setDoneRetryingOnce(setDone, 't1', false, 3)).resolves.toEqual({
      documentVersion: 8,
    });
    expect(setDone).toHaveBeenLastCalledWith('t1', { done: false, baseVersion: 7 });
  });

  it('gives up after one retry so the caller rolls back', async () => {
    const setDone = vi.fn().mockRejectedValue(stale(7));
    await expect(setDoneRetryingOnce(setDone, 't1', true, 3)).rejects.toBeInstanceOf(OatApiError);
    expect(setDone).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    const setDone = vi.fn().mockRejectedValue(new OatApiError(0, 'network', 'Boom'));
    await expect(setDoneRetryingOnce(setDone, 't1', true, 3)).rejects.toThrow('Boom');
    expect(setDone).toHaveBeenCalledOnce();
  });
});

describe('toggleFailure', () => {
  it('reloads the list when the note changed or is gone', () => {
    expect(toggleFailure(stale())).toMatchObject({ reload: true });
    expect(toggleFailure(new OatApiError(404, 'not_found', 'Gone'))).toMatchObject({
      reload: true,
    });
  });

  it('shows the server’s message otherwise', () => {
    expect(toggleFailure(new OatApiError(403, 'forbidden', 'Read only'))).toEqual({
      reload: false,
      description: 'Read only',
    });
    expect(toggleFailure('weird').description).toBe('Couldn’t update the task.');
  });
});
