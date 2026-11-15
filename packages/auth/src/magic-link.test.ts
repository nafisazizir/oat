import { describe, expect, it } from 'vitest';

import { isBlockedAuthPath, magicLinkConfirmUrl, magicLinkVerifyUrl } from './magic-link.ts';

const BASE = 'http://localhost:3000';

describe('magic link URLs', () => {
  it('emails a confirm-page link with the token and the post-sign-in path', () => {
    const verify = `${BASE}/api/auth/magic-link/verify?token=abc&callbackURL=%2Fd%2Fx%3Fy%3D1&errorCallbackURL=%2Fsign-in`;
    expect(magicLinkConfirmUrl(BASE, verify)).toBe(
      `${BASE}/sign-in/confirm?token=abc&next=%2Fd%2Fx%3Fy%3D1`,
    );
  });

  it('drops a cross-origin callback (falls back to the default on confirm)', () => {
    const verify = `${BASE}/api/auth/magic-link/verify?token=abc&callbackURL=https%3A%2F%2Fevil.test%2F`;
    expect(magicLinkConfirmUrl(BASE, verify)).toBe(`${BASE}/sign-in/confirm?token=abc`);
    expect(() => magicLinkConfirmUrl(BASE, `${BASE}/api/auth/magic-link/verify`)).toThrow();
  });

  it('blocks the public verify path and its variants, nothing else', () => {
    for (const path of [
      '/api/auth/magic-link/verify',
      '/api/auth/magic-link/verify/',
      '/api/auth//magic-link/verify',
      '/API/AUTH/Magic-Link/Verify',
      '/api/auth/magic-link/%76erify',
      '/api/auth/%E0%A4%A',
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
    for (const path of [
      '/api/auth/sign-in/magic-link',
      '/api/auth/get-session',
      '/api/auth/callback/google',
      '/api/auth/magic-link/verify-something',
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(false);
    }
  });

  it('builds the verify URL the confirm POST calls', () => {
    expect(magicLinkVerifyUrl(BASE, 't&1', '/settings')).toBe(
      `${BASE}/api/auth/magic-link/verify?token=t%261&callbackURL=%2Fsettings&errorCallbackURL=%2Fsign-in`,
    );
  });
});
