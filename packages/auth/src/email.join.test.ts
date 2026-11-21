import { describe, expect, it } from 'vitest';

import { joinDecisionEmail, joinRequestEmail } from './email.ts';

const url = 'http://localhost:3000/settings/workspace/members';

describe('joinRequestEmail', () => {
  const base = {
    to: 'olive@acme.test',
    url,
    workspaceName: 'Acme',
    requesterName: 'Sam Stranger',
    requesterEmail: 'sam@acme.test',
  };

  it('says who asked to join which workspace, in text and HTML, with our link only', () => {
    const mail = joinRequestEmail(base);
    expect(mail.to).toBe('olive@acme.test');
    expect(mail.subject).toBe('Sam Stranger asked to join Acme on Oat');
    expect(mail.text).toContain('Sam Stranger (sam@​acme.​test) asked to join the Acme');
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.html).toContain('<strong>Acme</strong>');
    expect(mail.html).not.toMatch(/https?:\/\/(?!localhost)/); // no remote assets
  });

  it('a requester without a name is shown by address, once', () => {
    const mail = joinRequestEmail({ ...base, requesterName: '  ' });
    expect(mail.subject).toBe('sam@​acme.​test asked to join Acme on Oat');
    expect(mail.text).not.toContain('(sam@');
  });

  it('user-controlled names can’t inject markup, lines or links', () => {
    const mail = joinRequestEmail({
      ...base,
      workspaceName: '<img src=x onerror=alert(1)>',
      requesterName: 'Sam\r\nBcc: victim@example.test https://evil.example/x',
    });
    expect(mail.html).not.toContain('<img');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    for (const body of [mail.subject, mail.text, mail.html]) {
      expect(body).not.toContain('https://evil');
      expect(body).not.toContain('evil.example');
    }
    expect(mail.text).toContain(url);
  });
});

describe('joinDecisionEmail', () => {
  const base = { to: 'sam@acme.test', url: 'http://localhost:3000/home', workspaceName: 'Acme' };

  it('approved: names the workspace and the role granted', () => {
    const mail = joinDecisionEmail({ ...base, approved: true, role: 'viewer' });
    expect(mail.subject).toBe('You’re in: Acme on Oat');
    expect(mail.text).toContain('was approved. You’re now a viewer.');
    expect(mail.text).toContain(base.url);
    expect(mail.html).toContain('You’re now a viewer.');
    // An unknown role reads as a member rather than leaking the raw value.
    expect(joinDecisionEmail({ ...base, approved: true, role: '<b>' }).html).not.toContain('<b>');
  });

  it('declined: says so, and doesn’t mention a role', () => {
    const mail = joinDecisionEmail({ ...base, approved: false });
    expect(mail.subject).toBe('Your request to join Acme on Oat was declined');
    expect(mail.text).toContain('was declined.');
    expect(mail.text).not.toContain('You’re now');
    expect(mail.html).toContain('was declined.');
  });

  it('escapes the workspace name', () => {
    const mail = joinDecisionEmail({ ...base, approved: true, workspaceName: 'A & <B>' });
    expect(mail.html).toContain('A &amp; &lt;B&gt;');
    expect(mail.html).not.toContain('<B>');
  });
});
