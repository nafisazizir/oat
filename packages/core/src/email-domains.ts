/**
 * Email domains for "find a workspace by email domain" (D-36). A workspace may list the domains whose
 * verified addresses can ask to join or join; a public mailbox domain — one where anyone can get an
 * address — can never be listed, and never matches even if a row for it exists.
 */

/**
 * Domains of public mailbox providers. Not exhaustive (it can't be): it covers the large consumer
 * providers, common ISP mailboxes and well-known disposable ones; the biggest providers' country domains
 * are matched by rule ({@link PUBLIC_MAILBOX_FAMILIES}). The other half of the rule is that an
 * owner/admin can only list the domain of their *own* verified address, so listing a public domain takes an
 * account there in the first place — at which point this list is what refuses it.
 */
export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'outlook.co.uk',
  'outlook.de',
  'outlook.fr',
  'outlook.jp',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.de',
  'hotmail.fr',
  'hotmail.it',
  'hotmail.es',
  'live.com',
  'live.co.uk',
  'live.de',
  'live.fr',
  'live.nl',
  'msn.com',
  'passport.com',
  // Yahoo / AOL
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.jp',
  'yahoo.co.in',
  'yahoo.de',
  'yahoo.fr',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.com.au',
  'yahoo.com.br',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'aim.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Independent providers
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'tutanota.com',
  'tutanota.de',
  'tutamail.com',
  'tuta.io',
  'tuta.com',
  'keemail.me',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'duck.com',
  'mailbox.org',
  'posteo.de',
  'posteo.net',
  'hushmail.com',
  'zoho.com',
  'zohomail.com',
  'mail.com',
  'email.com',
  'inbox.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'gmx.co.uk',
  'gmx.us',
  'web.de',
  't-online.de',
  'freenet.de',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'sfr.fr',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'yandex.com',
  'yandex.ru',
  'ya.ru',
  'mail.ru',
  'bk.ru',
  'list.ru',
  'inbox.ru',
  'rambler.ru',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'yeah.net',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'kakao.com',
  'rediffmail.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  // ISP mailboxes
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'shaw.ca',
  'rogers.com',
  'sympatico.ca',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'ntlworld.com',
  'bigpond.com',
  'optusnet.com.au',
  // Disposable
  'mailinator.com',
  'guerrillamail.com',
  'sharklasers.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'maildrop.cc',
  'dispostable.com',
  'throwawaymail.com',
  // Regional names that the family rule below doesn't reach
  'mail.de',
  '163.net',
  '126.net',
]);

/**
 * Providers that run the same mailbox service under many country domains (`live.ca`, `outlook.com.au`,
 * `yahoo.co.id`, `gmx.fr`, …). Matched by rule instead of listing every country: the registrable name —
 * the label right before the public suffix — is exactly one of these. A company whose name merely contains
 * one (`liveperson.com`, `outlookgroup.io`) is not affected. The rule errs towards "public": a company on,
 * say, `live.tv` can't use domain joining and invites people instead.
 */
export const PUBLIC_MAILBOX_FAMILIES: ReadonlySet<string> = new Set([
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'yahoo',
  'ymail',
  'rocketmail',
  'aol',
  'icloud',
  'proton',
  'protonmail',
  'gmx',
  'yandex',
]);

/** Second-level labels countries register under (`co.uk`, `com.au`, `ne.jp`, …). */
const COUNTRY_SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'net', 'org', 'ne', 'or']);

/** `<family>.<tld>` or `<family>.<co|com|…>.<two-letter country>`. */
function isPublicMailboxFamily(domain: string): boolean {
  const labels = domain.split('.');
  if (!PUBLIC_MAILBOX_FAMILIES.has(labels[0]!)) return false;
  if (labels.length === 2) return true;
  return labels.length === 3 && COUNTRY_SECOND_LEVEL.has(labels[1]!) && labels[2]!.length === 2;
}

/** A DNS hostname with at least two labels, already lower-cased (IDNs in their `xn--` form). */
const DOMAIN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * A domain as it is stored and compared: trimmed, lower-cased, without a leading `@` or a trailing dot.
 * `null` for anything that isn't a plain hostname with a dot in it.
 */
export function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return DOMAIN.test(domain) ? domain : null;
}

/** The domain of an email address (what follows the last `@`), normalised; `null` if there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  return normalizeDomain(email.slice(at + 1));
}

/**
 * Whether anyone can get an address on `domain` (expects a {@link normalizeDomain}d value): it is on the
 * list, or it is a country variant of one of the big providers ({@link PUBLIC_MAILBOX_FAMILIES}).
 */
export function isPublicMailboxDomain(domain: string): boolean {
  return PUBLIC_MAILBOX_DOMAINS.has(domain) || isPublicMailboxFamily(domain);
}
