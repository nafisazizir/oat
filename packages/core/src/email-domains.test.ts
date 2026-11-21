import { describe, expect, it } from 'vitest';

import {
  emailDomain,
  isPublicMailboxDomain,
  normalizeDomain,
  PUBLIC_MAILBOX_DOMAINS,
} from './email-domains.ts';

describe('normalizeDomain', () => {
  it('lower-cases and trims, and drops a leading @ or a trailing dot', () => {
    expect(normalizeDomain('  Acme.COM ')).toBe('acme.com');
    expect(normalizeDomain('@acme.com')).toBe('acme.com');
    expect(normalizeDomain('acme.com.')).toBe('acme.com');
    expect(normalizeDomain('mail.acme.co.uk')).toBe('mail.acme.co.uk');
    expect(normalizeDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  it('rejects anything that is not a hostname with a dot', () => {
    for (const value of [
      '',
      'localhost',
      'acme',
      '.com',
      'acme..com',
      '-acme.com',
      'acme-.com',
      'acme.c',
      'acme.123',
      'acme com',
      'acme.com/path',
      'https://acme.com',
      'a@b.com',
      'bücher.example',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(130)}com`,
    ]) {
      expect(normalizeDomain(value), value).toBeNull();
    }
  });
});

describe('emailDomain', () => {
  it('is what follows the last @, normalised', () => {
    expect(emailDomain('sam@acme.com')).toBe('acme.com');
    expect(emailDomain('Sam.Smith+tag@Mail.ACME.com')).toBe('mail.acme.com');
    expect(emailDomain('"odd@local"@acme.com')).toBe('acme.com');
  });

  it('is null without a local part or a usable domain', () => {
    for (const value of ['', 'sam', '@acme.com', 'sam@', 'sam@localhost', 'sam@acme com']) {
      expect(emailDomain(value), value).toBeNull();
    }
  });
});

describe('public mailbox domains', () => {
  it('includes the large consumer providers', () => {
    for (const domain of [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'hotmail.com',
      'live.com',
      'yahoo.com',
      'icloud.com',
      'aol.com',
      'proton.me',
      'protonmail.com',
      'gmx.de',
      'mail.ru',
      'qq.com',
    ]) {
      expect(isPublicMailboxDomain(domain), domain).toBe(true);
    }
  });

  it('does not include ordinary company domains', () => {
    for (const domain of ['acme.com', 'oat.test', 'example.test', 'gmail.com.acme.com']) {
      expect(isPublicMailboxDomain(domain), domain).toBe(false);
    }
  });

  it('holds only normalised domains, so a lookup by normalised domain can’t miss', () => {
    for (const domain of PUBLIC_MAILBOX_DOMAINS) {
      expect(normalizeDomain(domain), domain).toBe(domain);
    }
  });
});
