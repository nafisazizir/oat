/**
 * Transactional email for auth: the magic-link message (plain text + HTML, rendered locally with no
 * network or template engine) and a nodemailer SMTP mailer (Mailpit in dev, D-11).
 */
import { createTransport } from 'nodemailer';

import type { SmtpConfig } from './config.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** SMTP mailer. Any credentials work against Mailpit; blank user/password sends without AUTH. */
export function createSmtpMailer(smtp: SmtpConfig): Mailer {
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    // Implicit TLS on 465; otherwise STARTTLS when the server offers it (Mailpit doesn't).
    secure: smtp.port === 465,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
  });
  return {
    async send(message) {
      await transport.sendMail({ from: smtp.from, ...message });
    },
  };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The sign-in email. `url` is the one-time verify link; `expiresInMinutes` is shown to the reader. */
export function magicLinkEmail(input: {
  to: string;
  url: string;
  expiresInMinutes: number;
}): EmailMessage {
  const { to, url, expiresInMinutes } = input;
  const subject = 'Sign in to Oat';
  const text = [
    'Hi,',
    '',
    'Use this link to sign in to Oat:',
    url,
    '',
    `The link works once and expires in ${expiresInMinutes} minutes.`,
    'If you didn’t ask to sign in, you can ignore this email.',
    '',
    '— Oat',
  ].join('\n');

  const href = escapeHtml(url);
  // Email clients need inline styles and table layout; colours are fixed (no CSS variables in mail).
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2b2a26;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e7e3d9;border-radius:12px;padding:32px;">
            <tr><td style="font-size:22px;font-weight:600;padding-bottom:16px;">Oat</td></tr>
            <tr><td style="font-size:15px;line-height:1.5;padding-bottom:24px;">Click the button below to sign in. The link works once and expires in ${expiresInMinutes} minutes.</td></tr>
            <tr>
              <td style="padding-bottom:24px;">
                <a href="${href}" style="display:inline-block;background:#3f4a36;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px;">Sign in to Oat</a>
              </td>
            </tr>
            <tr><td style="font-size:13px;line-height:1.5;color:#6b6759;padding-bottom:8px;">Or paste this link into your browser:</td></tr>
            <tr><td style="font-size:13px;line-height:1.5;word-break:break-all;padding-bottom:24px;"><a href="${href}" style="color:#3f4a36;">${href}</a></td></tr>
            <tr><td style="font-size:13px;line-height:1.5;color:#6b6759;">If you didn’t ask to sign in, you can ignore this email.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  return { to, subject, text, html };
}
