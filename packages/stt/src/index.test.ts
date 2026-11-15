import { describe, expect, it } from 'vitest';

import { packageName } from './index.ts';

describe('@oat/stt', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@oat/stt');
  });
});
