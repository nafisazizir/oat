import { describe, expect, it } from 'vitest';

import { emailSafeText, escapeHtml, invitationEmail, magicLinkEmail, unlinkable } from './email.ts';

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

describe('invitationEmail', () => {
  const base = {
    to: 'grace@example.test',
    url: 'http://localhost:3000/invite/tok_123',
    workspaceName: 'Acme Design',
    inviterName: 'Ada Lovelace',
    role: 'admin',
    expiresInDays: 7,
  };

  it('renders plain text and HTML with the link, workspace, inviter, role and expiry', () => {
    const mail = invitationEmail(base);
    expect(mail.to).toBe('grace@example.test');
    expect(mail.subject).toBe('Ada Lovelace invited you to Acme Design on Oat');
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain(base.url);
      expect(body).toContain('Acme Design');
      expect(body).toContain('Ada Lovelace');
      expect(body).toContain('an admin');
      expect(body).toContain('7 days');
      expect(body).toContain('grace@example.test');
    }
    expect(mail.html).not.toMatch(/https?:\/\/(?!localhost)/); // no remote assets
  });

  it('escapes user-controlled names and keeps them on one line', () => {
    const mail = invitationEmail({
      ...base,
      workspaceName: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.test',
      inviterName: '"><script>alert(1)</script>',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    // The injected "header" stays inside the sentence on line 3.
    expect(mail.text.split('\n')[2]).toContain('Bcc: victim@');
  });

  it('names can’t carry links: URL-like text is broken with zero-width spaces', () => {
    const mail = invitationEmail({
      ...base,
      workspaceName: 'Verify at https://evil.example/login',
      inviterName: 'support@evil.example',
    });
    for (const body of [mail.text, mail.html, mail.subject]) {
      expect(body).not.toContain('https://evil');
      expect(body).not.toContain('evil.example');
      expect(body).not.toContain('@evil');
    }
    // Our own link is untouched.
    expect(mail.text).toContain(base.url);
    expect(unlinkable('www.evil.com')).toBe('www.\u200Bevil.\u200Bcom');
    expect(unlinkable('Acme Design')).toBe('Acme Design');
    // Zero-width characters in the input can't be used to pre-empt the breaking.
    expect(unlinkable('evil\u200B.com')).toBe('evil.\u200Bcom');
  });

  it('flattens whitespace and caps long names', () => {
    expect(emailSafeText('x'.repeat(200), 60)).toHaveLength(60);
    expect(emailSafeText('  a \n\t b  ')).toBe('a b');
  });
});
