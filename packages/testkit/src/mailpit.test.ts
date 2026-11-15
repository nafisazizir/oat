import { describe, expect, it } from 'vitest';
import { extractFirstLink, uniqueAddress } from './mailpit.ts';

describe('extractFirstLink', () => {
  it('takes the first href from the HTML part and decodes entities', () => {
    const html =
      '<p>Hi</p><a class="btn" href="https://oat.test/verify?token=a&amp;next=%2F">Sign in</a>' +
      '<a href="https://oat.test/other">x</a>';
    expect(extractFirstLink({ HTML: html, Text: '' })).toBe(
      'https://oat.test/verify?token=a&next=%2F',
    );
  });

  it('handles single-quoted and unquoted hrefs', () => {
    expect(extractFirstLink("<a href='http://a.test/x'>")).toBe('http://a.test/x');
    expect(extractFirstLink('<a href=http://b.test/y>')).toBe('http://b.test/y');
  });

  it('skips non-http hrefs and falls back to the text part', () => {
    const message = {
      HTML: '<a href="mailto:help@oat.test">help</a>',
      Text: 'Open (https://oat.test/magic?t=1) to continue.',
    };
    expect(extractFirstLink(message)).toBe('https://oat.test/magic?t=1');
  });

  it('returns undefined when there is no link', () => {
    expect(extractFirstLink({ HTML: '', Text: 'no links here' })).toBeUndefined();
  });
});

describe('uniqueAddress', () => {
  it('is unique and well-formed', () => {
    const a = uniqueAddress('magic');
    expect(a).toMatch(/^magic-[0-9a-f]{10}@oat\.test$/);
    expect(uniqueAddress('magic')).not.toBe(a);
  });
});
