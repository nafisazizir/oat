import { randomBytes } from 'node:crypto';
import { mailpitUrl } from './env.ts';
import { waitFor, type WaitForOptions } from './wait-for.ts';

/**
 * Helpers for Mailpit's REST API (https://mailpit.axllent.org/docs/api-v1/). The Mailpit instance is shared
 * by every worktree and test run, so tests should send to a `uniqueAddress()` and only look at their own
 * mail; there is deliberately no "delete everything" helper.
 */

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitSummary {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
  Snippet: string;
}

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Date: string;
  Text: string;
  HTML: string;
}

/** A recipient no other test will use: `<prefix>-<random>@oat.test`. */
export function uniqueAddress(prefix = 'test'): string {
  return `${prefix}-${randomBytes(5).toString('hex')}@oat.test`;
}

export interface Mailpit {
  /** Messages addressed to `address`, newest first. */
  listFor(address: string, limit?: number): Promise<MailpitSummary[]>;
  /** Full message (text + HTML). */
  get(id: string): Promise<MailpitMessage>;
  /** Newest message to `address`, or `undefined` if none yet. */
  latestFor(address: string): Promise<MailpitMessage | undefined>;
  /** Polls until a message to `address` arrives (mail delivery is async). */
  waitForLatest(address: string, options?: WaitForOptions): Promise<MailpitMessage>;
  /** Deletes the given messages (e.g. a test cleaning up its own mail). */
  delete(ids: string[]): Promise<void>;
}

export function createMailpit(baseUrl: string = mailpitUrl()): Mailpit {
  const base = baseUrl.replace(/\/+$/, '');

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1${path}`, init);
    } catch (err) {
      throw new Error(`@oat/testkit: cannot reach Mailpit at ${base}. Is the dev stack up?`, {
        cause: err,
      });
    }
    if (!res.ok) throw new Error(`Mailpit ${init?.method ?? 'GET'} ${path} → ${res.status}`);
    const text = await res.text();
    return (
      text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
    ) as T;
  }

  const mailpit: Mailpit = {
    async listFor(address, limit = 50) {
      const query = encodeURIComponent(`to:"${address}"`);
      const res = await api<{ messages: MailpitSummary[] }>(
        `/search?query=${query}&limit=${limit}`,
      );
      return res.messages;
    },
    get(id) {
      return api<MailpitMessage>(`/message/${encodeURIComponent(id)}`);
    },
    async latestFor(address) {
      const [latest] = await mailpit.listFor(address, 1);
      return latest ? mailpit.get(latest.ID) : undefined;
    },
    waitForLatest(address, options) {
      return waitFor(() => mailpit.latestFor(address), {
        message: `no email to ${address}`,
        ...options,
      });
    },
    async delete(ids) {
      if (ids.length === 0) return;
      await api('/messages', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ IDs: ids }),
      });
    },
  };
  return mailpit;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * First http(s) link in a message: the first `href` in the HTML part (entities decoded), else the first URL
 * in the text part. Accepts a Mailpit message or a raw HTML/text string.
 */
export function extractFirstLink(
  message: Pick<MailpitMessage, 'HTML' | 'Text'> | string,
): string | undefined {
  const html = typeof message === 'string' ? message : message.HTML;
  const text = typeof message === 'string' ? message : message.Text;
  const href = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html ?? '');
  const fromHref = href && decodeEntities((href[1] ?? href[2] ?? href[3] ?? '').trim());
  if (fromHref && /^https?:\/\//i.test(fromHref)) return fromHref;
  const plain = /https?:\/\/[^\s<>"')\]]+/i.exec(text ?? '');
  return plain?.[0];
}
