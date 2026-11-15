import { ForbiddenError } from '@oat/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { asRejection } from './push';

const pg = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const wrapped = (cause: unknown) => Object.assign(new Error('query failed'), { cause });

describe('asRejection (2.6 review: one entry never fails the whole push)', () => {
  it('maps known refusals', () => {
    expect(asRejection(new ForbiddenError('editDocument'))).toMatchObject({ code: 'forbidden' });
    expect(asRejection(new ApiError(404, 'not_found', 'x'))).toMatchObject({ code: 'not_found' });
    expect(asRejection(new ApiError(400, 'invalid_content', 'x'))).toMatchObject({
      code: 'invalid',
    });
    expect(asRejection(wrapped(pg('23505')))).toMatchObject({ code: 'invalid' });
    expect(asRejection(pg('22003'))).toMatchObject({ code: 'invalid' });
  });

  it('turns unexpected errors into rejected/invalid (logged)', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(asRejection(new TypeError('toMarkdown blew up'))).toMatchObject({ code: 'invalid' });
    expect(asRejection(pg('42P01'))).toMatchObject({ code: 'invalid' });
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('rethrows infrastructure errors (the request fails and is retried)', () => {
    for (const e of [
      pg('08006'),
      wrapped(pg('40001')),
      pg('40P01'),
      pg('53300'),
      pg('57P01'),
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      wrapped(Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })),
      new ApiError(503, 'stt_unavailable', 'x'),
    ]) {
      expect(asRejection(e), String(e)).toBeUndefined();
    }
  });
});
