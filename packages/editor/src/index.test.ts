import { describe, expect, it } from 'vitest';

import { packageName } from './index.ts';

describe('@oat/editor', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@oat/editor');
  });
});
