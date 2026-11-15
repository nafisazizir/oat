import { describe, expect, it } from 'vitest';

import { eventId, requestLocale } from './api';

const req = (value?: string) =>
  new Request('http://localhost/x', value ? { headers: { 'accept-language': value } } : {});

describe('requestLocale', () => {
  it('takes the first Accept-Language tag, en-US otherwise', () => {
    expect(requestLocale(req('de-CH,de;q=0.9,en;q=0.8'))).toBe('de-CH');
    expect(requestLocale(req('en-GB'))).toBe('en-GB');
    expect(requestLocale(req('*'))).toBe('en-US');
    expect(requestLocale(req('"><script>'))).toBe('en-US');
    expect(requestLocale(req())).toBe('en-US');
  });
});

describe('eventId', () => {
  it('accepts only ids the broker issues', () => {
    expect(eventId('1731641130764-0')).toBe('1731641130764-0');
    expect(eventId('7')).toBe('7');
    expect(eventId('final')).toBeNull();
    expect(eventId('(0-0')).toBeNull();
    expect(eventId('')).toBeNull();
    expect(eventId(null)).toBeNull();
  });
});
