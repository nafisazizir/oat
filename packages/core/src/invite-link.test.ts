import { describe, expect, it } from 'vitest';
import { desktopInviteUrl, parseInviteLink } from './invite-link';

const token = 'a'.repeat(32);
describe('desktop invite links', () => {
  it('accepts only a canonical URL-safe invitation token', () => {
    expect(desktopInviteUrl(token)).toBe(`oat://invite/${token}`);
    expect(parseInviteLink(`oat://invite/${token}`)).toBe(token);
    expect(desktopInviteUrl('')).toBeNull();
  });
  it.each([
    null,
    '',
    'oat://invite',
    'https://invite/' + token,
    'oat://auth/' + token,
    'oat://invite/' + token + '?next=https://evil.test',
    'oat://invite/' + token + '#x',
    'oat://user@invite/' + token,
    'oat://invite:80/' + token,
    'oat://invite/' + token + '/',
    'oat://invite/' + 'a'.repeat(31),
    'oat://invite/' + 'a'.repeat(33),
    'oat://invite/%61' + token.slice(1),
    'oat://invite/../' + token,
    'oat://invite/' + token + '\n',
    'oat://invite/' + token + '/other',
  ])('rejects malformed or non-invite input %j', (raw) => expect(parseInviteLink(raw)).toBeNull());
});
