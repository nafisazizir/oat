import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { GOOGLE_CALENDAR_PROVIDER_ID } from '@oat/auth';
import { session, verification } from '@oat/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { loadActor } from './actor';
import { apiDeps, apiRateLimiter, notionDeps } from './api';
import { ApiError, badRequest, forbidden } from './api/errors';
import { apiRoute, readJson } from './api/route';
import { getAuth, getAuthConfig } from './auth';
import { getDb } from './db';
import { completeNotionConnect, NotionConnectError, startNotionConnect } from './notion';

const START_PATH = '/api/settings/consent/browser';
const DONE_PATH = '/api/settings/consent/done';
const NOTION_COOKIE = 'oat_desktop_notion_state';
const NOTION_PATH = '/api/integrations/notion/callback';
const SCOPE = 'oat-desktop-consent:';
const TTL = 5 * 60;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const PRIVACY = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const StartInput = z.strictObject({
  provider: z.enum(['notion', 'google-calendar']),
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
});
const BrowserHandoff = z.object({
  url: z.url(),
  cookie: z.string(),
  sessionId: z.string(),
  userId: z.string(),
  email: z.email(),
});

const keyFor = (kind: string, proof: string) =>
  SCOPE + kind + ':' + createHash('sha256').update(proof).digest('hex');

function secure(base: string) {
  return new URL(base).protocol === 'https:' ? '; Secure' : '';
}

function redirect(url: string, cookie?: string) {
  const headers = new Headers({ ...PRIVACY, location: url });
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

async function currentSession(sessionId: string, userId: string) {
  const [current] = await getDb()
    .select({ id: session.id })
    .from(session)
    .where(
      and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date())),
    );
  return Boolean(current);
}

async function consume(identifier: string) {
  const [row] = await getDb()
    .delete(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .returning({ value: verification.value });
  return row?.value;
}

export const desktopConsentStart = apiRoute(apiDeps, async ({ request, actor, db }) => {
  if (
    !request.headers.get('authorization')?.startsWith('Bearer ') ||
    request.headers.has('cookie')
  ) {
    throw forbidden('Start this connection from Oat desktop.');
  }
  const signedIn = await getAuth().api.getSession({ headers: request.headers });
  if (!signedIn) throw new ApiError(401, 'unauthorized', 'Not signed in.');
  const input = await readJson(request, StartInput);
  const rate = await apiRateLimiter().hit(`desktop-consent:${actor.userId}`, 10, 60);
  if (!rate.allowed) throw new ApiError(429, 'rate_limited', 'Try again in a minute.');
  const base = getAuthConfig().baseURL;
  const expiresAt = new Date(Date.now() + TTL * 1000);
  const ticket = randomBytes(32).toString('base64url');
  const owner = { sessionId: signedIn.session.id, userId: actor.userId };
  let browser: z.infer<typeof BrowserHandoff>;
  const pending: { identifier: string; value: string; expiresAt: Date }[] = [];

  if (input.provider === 'notion') {
    const start = startNotionConnect(notionDeps(), actor, input.workspaceId);
    const cookie = `${NOTION_COOKIE}=${encodeURIComponent(start.cookie.value)}; Path=${NOTION_PATH}; Max-Age=${TTL}; HttpOnly; SameSite=Lax${secure(base)}`;
    browser = { ...owner, url: start.url, cookie, email: signedIn.user.email };
    pending.push({
      identifier: keyFor('notion', start.cookie.value),
      value: JSON.stringify(owner),
      expiresAt,
    });
  } else {
    const result = await getAuth().api.linkSocialAccount({
      headers: request.headers,
      body: {
        provider: GOOGLE_CALENDAR_PROVIDER_ID,
        callbackURL: `${DONE_PATH}?connected=1`,
        errorCallbackURL: DONE_PATH,
        disableRedirect: true,
      },
      asResponse: true,
    });
    if (!result.ok) throw badRequest('Couldn’t start connecting Google Calendar.');
    const data = z.object({ url: z.url() }).parse(await result.json());
    const cookie = result.headers
      .getSetCookie()
      .find((value) => /^(?:__Secure-)?[\w-]+\.(?:oauth_state|state)=/.test(value));
    if (!cookie) throw badRequest('Couldn’t start connecting Google Calendar.');
    browser = { ...owner, url: data.url, cookie, email: signedIn.user.email };
  }

  pending.push({ identifier: keyFor('launch', ticket), value: JSON.stringify(browser), expiresAt });
  await db.transaction(async (tx) => {
    await tx
      .delete(verification)
      .where(
        and(
          sql`${verification.identifier} like ${SCOPE + '%'}`,
          lt(verification.expiresAt, new Date()),
        ),
      );
    await tx.insert(verification).values(pending);
  });
  const url = new URL(START_PATH, base);
  url.searchParams.set('ticket', ticket);
  return { url: url.href };
});

export async function openDesktopConsent(request: Request) {
  const ticket = new URL(request.url).searchParams.get('ticket');
  if (!ticket || !TICKET.test(ticket)) return browserPage(false);
  const [entry] = await getDb()
    .select({ value: verification.value })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, keyFor('launch', ticket)),
        gt(verification.expiresAt, new Date()),
      ),
    );
  if (!entry) return browserPage(false);
  const parsed = BrowserHandoff.safeParse(JSON.parse(entry.value));
  if (!parsed.success) return browserPage(false);
  const flow = parsed.data;
  if (!(await currentSession(flow.sessionId, flow.userId))) return browserPage(false);
  const email = flow.email.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return consentPage(
    'Confirm your Oat account',
    `<p>This connection will be saved to the Oat account <strong>${email}</strong>.</p><p>Continue only if this is your account and you started this connection in Oat desktop. Otherwise, close this tab.</p><form action="${START_PATH}" method="post"><input type="hidden" name="ticket" value="${ticket}"><button type="submit">Continue</button></form>`,
    200,
  );
}

export async function confirmDesktopConsent(request: Request) {
  if (
    request.headers.get('origin') !== new URL(getAuthConfig().baseURL).origin ||
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/x-www-form-urlencoded'
  )
    return browserPage(false);
  const ticket = new URLSearchParams(await request.text()).get('ticket');
  if (!ticket || !TICKET.test(ticket)) return browserPage(false);
  const value = await consume(keyFor('launch', ticket));
  if (!value) return browserPage(false);
  const parsed = BrowserHandoff.safeParse(JSON.parse(value));
  return parsed.success && (await currentSession(parsed.data.sessionId, parsed.data.userId))
    ? redirect(parsed.data.url, parsed.data.cookie)
    : browserPage(false);
}

export async function completeDesktopNotion(request: Request): Promise<Response | null> {
  const query = new URL(request.url).searchParams;
  const raw = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(NOTION_COOKIE + '='))
    ?.slice(NOTION_COOKIE.length + 1);
  if (!raw) return null;
  let cookie: string;
  try {
    cookie = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!query.get('state') || !cookie.startsWith(query.get('state') + '.')) return null;

  const base = getAuthConfig().baseURL;
  const done = new URL(DONE_PATH, base);
  const clear = `${NOTION_COOKIE}=; Path=${NOTION_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure(base)}`;
  const value = await consume(keyFor('notion', cookie));
  if (!value) return redirect(done.href, clear);
  const owner = z.object({ sessionId: z.string(), userId: z.string() }).parse(JSON.parse(value));
  if (!(await currentSession(owner.sessionId, owner.userId))) return redirect(done.href, clear);

  try {
    const actor = await loadActor(getDb(), owner.userId);
    await completeNotionConnect(notionDeps(), actor, {
      code: query.get('code'),
      state: query.get('state'),
      error: query.get('error'),
      cookie,
    });
    done.searchParams.set('connected', '1');
  } catch (error) {
    if (!(error instanceof NotionConnectError)) throw error;
  }
  return redirect(done.href, clear);
}

export function desktopConsentDone(request: Request) {
  return browserPage(new URL(request.url).searchParams.get('connected') === '1');
}

function browserPage(connected: boolean) {
  const title = connected ? 'Connection complete' : 'Connection not completed';
  const text = connected
    ? 'You can close this tab and return to Oat.'
    : 'Return to Oat to check the connection or try again.';
  return consentPage(title, `<p>${text}</p>`, connected ? 200 : 400);
}

function consentPage(title: string, content: string, status: number) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Oat</title></head><body><main><h1>${title}</h1>${content}</main></body></html>`,
    {
      status,
      headers: {
        ...PRIVACY,
        'referrer-policy': 'strict-origin',
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}
