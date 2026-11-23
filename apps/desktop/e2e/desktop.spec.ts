import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import {
  APP_DIR,
  deliverDeepLink,
  evidence,
  launchApp,
  openedUrls,
  readStoredSession,
  signInOnWeb,
  waitForSignInUrl,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;

test.beforeAll(({ baseURL }) => {
  webUrl = baseURL!;
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-e2e-'));
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

async function relaunch() {
  await app?.close();
  ({ app, page } = await launchApp(userDataDir, webUrl));
  return app!;
}

/** Who the server says the stored token belongs to (an authenticated call through main). */
function connectedAs(p: Page) {
  return p.evaluate(async () => {
    const oat = window.oat as unknown as {
      invoke(c: string): Promise<{ ok: boolean; value?: { user: { email: string } } }>;
    };
    return (await oat.invoke('api:me')).value?.user.email;
  });
}

/** Everything the renderer can see, as one string (to prove the token isn't in it). */
function rendererView(p: Page) {
  return p.evaluate(async () => {
    const oat = window.oat;
    const results = await Promise.all([
      oat.invoke('state:get'),
      oat.invoke('app:info'),
      oat.invoke('api:me'),
    ]);
    return JSON.stringify({
      keys: Object.keys(oat),
      results,
      html: document.documentElement.outerHTML,
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
    });
  });
}

test('launches hardened: shell renders, bridge only, strict CSP, fast cold start', async () => {
  const electronApp = await relaunch();
  await expect(page).toHaveTitle('Oat');
  expect(page.url()).toBe('app://oat/index.html#/main');
  await expect(page.getByRole('heading', { name: 'Welcome to Oat' })).toBeVisible();

  const env = await page.evaluate(async () => ({
    bridgeKeys: Object.keys(window.oat).sort(),
    require: typeof (window as { require?: unknown }).require,
    process: typeof (window as { process?: unknown }).process,
    // contextBridge hands the page a frozen copy, not the preload's object.
    bridgeFrozen: Object.isFrozen(window.oat),
    // An injected inline script must not run (CSP `script-src 'self'`). (Playwright's own `evaluate`
    // goes through the DevTools protocol, which CSP doesn't apply to, so this is tested via the DOM.)
    inlineScriptBlocked: await new Promise<boolean>((resolve) => {
      const script = document.createElement('script');
      script.textContent = 'window.__inlineRan = true';
      document.head.append(script);
      setTimeout(() => resolve(!(window as { __inlineRan?: boolean }).__inlineRan), 50);
    }),
    csp: await fetch(location.href).then((r) => r.headers.get('content-security-policy')),
  }));
  expect(env).toEqual({
    bridgeKeys: ['invoke', 'platform', 'send', 'subscribe', 'version'],
    require: 'undefined',
    process: 'undefined',
    bridgeFrozen: true,
    inlineScriptBlocked: true,
    csp: expect.stringContaining("script-src 'self';"),
  });

  // Unknown channels never reach IPC; bad payloads are refused by main.
  const refused = await page.evaluate(async () => {
    const oat = window.oat as unknown as {
      invoke: (c: string, p?: unknown) => Promise<unknown>;
    };
    const unknown = await oat.invoke('fs:read', '/etc/passwd').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    const invalid = await oat.invoke('auth:complete-from-link', { url: 42 });
    return { unknown, invalid };
  });
  expect(refused.unknown).toContain('Unknown channel');
  expect(refused.invalid).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });

  // window.open is denied (no new window); the link is handed to the browser instead.
  await page.evaluate(() => window.open('https://example.com/docs'));
  expect(electronApp.windows()).toHaveLength(1);
  // Main hands the URL over asynchronously (window-open handler), so poll for it.
  await expect.poll(() => openedUrls(electronApp)).toContain('https://example.com/docs');

  await expect(page.getByTestId('app-info')).toContainText('ready in');
  const info = await page.evaluate(() => window.oat.invoke('app:info'));
  expect(info.ok).toBe(true);
  const coldStartMs = info.ok ? info.value.coldStartMs : null;
  console.log(`[e2e] cold start: ${coldStartMs} ms (process start → main window rendered)`);
  expect(coldStartMs).not.toBeNull();
  expect(coldStartMs!).toBeLessThan(2000);
  writeEvidence('cold-start.json', {
    coldStartMs,
    measured: 'Electron process start → main window first render (app:rendered)',
    at: new Date().toISOString(),
  });
  await evidence(page, 'main-signed-out');
});

test('refuses IPC from a page that is not our renderer', async () => {
  const electronApp = app!;
  // A window running our preload but showing foreign content: it has window.oat, main must refuse it.
  const result = await electronApp.evaluate(
    async ({ BrowserWindow }, preload) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true },
      });
      await foreign.loadURL('data:text/html,<p>not oat</p>');
      const out = await foreign.webContents.executeJavaScript(
        `Promise.all([window.oat.invoke('state:get'), window.oat.invoke('auth:sign-in')])`,
      );
      foreign.destroy();
      return out as unknown[];
    },
    join(APP_DIR, 'out/preload/index.cjs'),
  );
  expect(result).toEqual([
    { ok: false, error: { code: 'forbidden', message: expect.any(String) } },
    { ok: false, error: { code: 'forbidden', message: expect.any(String) } },
  ]);
  // …and it did not start a sign-in.
  await expect(page.getByRole('heading', { name: 'Welcome to Oat' })).toBeVisible();
  expect(await openedUrls(electronApp)).not.toContainEqual(expect.stringContaining('/desktop/'));
});

test('signs in through the browser and the oat:// deep link; the token stays in main', async ({
  browser,
}) => {
  const electronApp = app!;
  await page.getByRole('button', { name: 'Sign in with your browser' }).click();
  await expect(
    page.getByRole('heading', { name: 'Finish signing in in your browser' }),
  ).toBeVisible();
  // Unpackaged build: the dev-only paste fallback is offered (a packaged app never shows it).
  await expect(page.getByLabel(/Dev build: browser didn’t switch back/)).toBeVisible();
  await evidence(page, 'main-signing-in');

  const signInUrl = await waitForSignInUrl(electronApp);
  expect(signInUrl).toMatch(
    new RegExp(`^${webUrl}/desktop/sign-in\\?state=[\\w-]{43}&challenge=[\\w-]{43}$`),
  );
  const state = new URL(signInUrl).searchParams.get('state')!;

  // The browser half: sign in on the web, then "Continue to the app".
  const context = await browser.newContext();
  const web = await context.newPage();
  await web.goto(signInUrl);
  await expect(web).toHaveURL(/\/sign-in\?next=%2Fdesktop%2Fsign-in/);
  const email = uniqueAddress('desktop');
  await signInOnWeb(web, email);
  await expect(web).toHaveURL(/\/desktop\/sign-in\?state=/);
  await expect(web.getByTestId('desktop-email')).toHaveText(email);
  await expect(web.getByTestId('desktop-warning')).toContainText('Never share this link or code.');
  await evidence(web, 'web-desktop-sign-in');
  const codeResponse = web.waitForResponse(
    (r) => r.url().endsWith('/api/auth/desktop/code') && r.request().method() === 'POST',
  );
  await web.getByRole('button', { name: 'Continue to the app' }).click();
  const issued = await codeResponse;
  expect(issued.status()).toBe(200);
  const { redirectUrl } = (await issued.json()) as { redirectUrl: string };
  expect(redirectUrl).toMatch(/^oat:\/\/auth\?code=[\w-]{43}&state=[\w-]{43}$/);
  expect(new URL(redirectUrl).searchParams.get('state')).toBe(state);
  await expect(web.getByTestId('desktop-opened')).toBeVisible();
  // `next dev` without OAT_DESKTOP_DEV_HANDOFF: the dev-only copy fallback is there.
  await expect(web.getByRole('button', { name: 'Copy link for the app (dev)' })).toBeVisible();
  await evidence(web, 'web-desktop-opened');
  await context.close();

  // A link with another state (e.g. from a malicious page) is ignored; the app keeps waiting.
  const forged = redirectUrl.replace(/state=[\w-]+/, `state=${'x'.repeat(43)}`);
  await deliverDeepLink(electronApp, forged);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('signing-in')).toBeVisible();

  // The real link, as macOS delivers it.
  await deliverDeepLink(electronApp, redirectUrl);
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  expect(await connectedAs(page)).toBe(email);

  // Stored with safeStorage: encrypted on disk, decryptable in main only.
  const stored = await readStoredSession(electronApp);
  expect(stored).not.toBeNull();
  const { token, user } = JSON.parse(stored!.plain) as { token: string; user: { email: string } };
  expect(user.email).toBe(email);
  expect(token).toMatch(/^[^.]+\.[^.]+$/);
  const sessionPart = decodeURIComponent(token).split('.')[0]!;
  expect(stored!.raw).not.toContain(sessionPart);

  // It is a real bearer token for this user…
  const session = await (
    await fetch(`${webUrl}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(session.user.email).toBe(email);

  // …that the renderer can't see anywhere.
  const view = await rendererView(page);
  expect(view).toContain(email);
  expect(view).not.toContain(sessionPart);

  // The sign-in can't be replayed.
  await deliverDeepLink(electronApp, redirectUrl);
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await evidence(page, 'main-signed-in');

  // Second window, same main-owned state.
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-account')).toHaveText(email);
  await expect(widget.getByTestId('widget-recording')).toHaveText('Not recording');
  expect(widget.url()).toBe('app://oat/index.html#/widget');
  await evidence(widget, 'widget');
  await widget.getByRole('button', { name: 'Close widget' }).click();
  await expect.poll(() => electronApp.windows().length).toBe(1);
});

test('keeps the session across restarts; sign-out revokes it', async () => {
  const before = await readStoredSession(app!);
  const { token, user } = JSON.parse(before!.plain) as { token: string; user: { email: string } };

  // Restart: signed in straight from the Keychain-encrypted file, no browser.
  const electronApp = await relaunch();
  await expect(page.getByTestId('signed-in-email')).toHaveText(user.email);
  expect(await connectedAs(page)).toBe(user.email);
  expect(await openedUrls(electronApp)).toEqual([]);

  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Oat' })).toBeVisible();
  expect(await readStoredSession(electronApp)).toBeNull();
  const res = await fetch(`${webUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toBeNull();
  const me = await page.evaluate(() => window.oat.invoke('api:me'));
  expect(me).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
});
