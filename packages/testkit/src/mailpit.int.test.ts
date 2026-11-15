import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { smtpConfig } from './env.ts';
import { createMailpit, extractFirstLink, uniqueAddress } from './mailpit.ts';

describe('Mailpit helpers (compose SMTP + API)', () => {
  it('reads back an email sent over SMTP and extracts its first link', async () => {
    const to = uniqueAddress('magic');
    const transport = nodemailer.createTransport({ ...smtpConfig(), secure: false });
    await transport.sendMail({
      from: 'Oat <no-reply@oat.localhost>',
      to,
      subject: 'Your sign-in link',
      text: 'Sign in: http://localhost:3000/auth/verify?token=abc&next=%2F',
      html: '<p><a href="http://localhost:3000/auth/verify?token=abc&amp;next=%2F">Sign in</a></p>',
    });
    transport.close();

    const mailpit = createMailpit();
    const message = await mailpit.waitForLatest(to);
    expect(message.Subject).toBe('Your sign-in link');
    expect(message.To.map((a) => a.Address)).toEqual([to]);
    expect(extractFirstLink(message)).toBe('http://localhost:3000/auth/verify?token=abc&next=%2F');

    await mailpit.delete([message.ID]);
    expect(await mailpit.latestFor(to)).toBeUndefined();
  });

  it('only sees mail for the given address', async () => {
    const mailpit = createMailpit();
    expect(await mailpit.listFor(uniqueAddress('nobody'))).toEqual([]);
    await expect(
      mailpit.waitForLatest(uniqueAddress('nobody'), { timeout: 200, interval: 50 }),
    ).rejects.toThrow(/no email to nobody-/);
  });
});
