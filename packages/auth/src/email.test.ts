import { describe, expect, it } from 'vitest';

import { escapeHtml, magicLinkEmail } from './email.ts';

describe('magicLinkEmail', () => {
  const url = 'http://localhost:3000/api/auth/magic-link/verify?token=abc&callbackURL=%2Fhome';

  it('renders plain text and HTML with the same link and expiry', () => {
    const mail = magicLinkEmail({ to: 'ada@example.test', url, expiresInMinutes: 15 });
    expect(mail.to).toBe('ada@example.test');
    expect(mail.subject).toBe('Sign in to Oat');
    expect(mail.text).toContain(url);
    expect(mail.text).toContain('15 minutes');
    // `&` is escaped in the attribute; a mail client decodes it back to the same URL.
    expect(mail.html).toContain(`href="${url.replace('&', '&amp;')}"`);
    expect(mail.html).toContain('15 minutes');
    expect(mail.html).not.toMatch(/https?:\/\/(?!localhost)/); // no remote assets
  });

  it('escapes the URL so it cannot break out of the attribute', () => {
    const mail = magicLinkEmail({
      to: 'x@example.test',
      url: 'http://localhost/"><script>alert(1)</script>',
      expiresInMinutes: 5,
    });
    expect(mail.html).not.toContain('<script>');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
