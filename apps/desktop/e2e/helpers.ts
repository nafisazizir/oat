import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMailpit, extractFirstLink } from '@oat/testkit';
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
} from '@playwright/test';

/** The desktop package: Electron loads `out/main/index.js` from its package.json. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
/** Evidence for task 1.8 (screenshots only with `E2E_SCREENSHOTS=1`: they are tracked files). */
export const EVIDENCE = fileURLToPath(
  new URL('../../../docs/tasks/evidence/1.8/', import.meta.url),
);

const mailpit = createMailpit();

/**
 * Launches the built app with its own userData folder, pointed at the test web server. `OAT_E2E=1`:
 * windows don't take focus and `oat://` is never registered with the OS. `shell.openExternal` is
 * replaced in the main process so the system browser never opens; the URLs are recorded instead.
 */
export async function launchApp(userDataDir: string, webUrl: string) {
  const app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...(process.env as Record<string, string>),
      OAT_E2E: '1',
      OAT_USER_DATA_DIR: userDataDir,
      OAT_WEB_URL: webUrl,
    },
  });
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __oatOpened?: string[] };
    g.__oatOpened = [];
    shell.openExternal = async (url: string) => void g.__oatOpened!.push(url);
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('shell')).toBeVisible();
  return { app, page };
}

/** URLs the app asked the OS to open in the browser. */
export function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { __oatOpened?: string[] }).__oatOpened ?? []);
}

/** What macOS does when the browser opens an `oat://` link: `open-url` on the app. */
export async function deliverDeepLink(app: ElectronApplication, url: string) {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault() {} }, link);
  }, url);
}

/** The session file as written (base64) and as decrypted with safeStorage in the main process. */
export function readStoredSession(app: ElectronApplication) {
  return app.evaluate(({ app: electronApp, safeStorage }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const file = path.join(electronApp.getPath('userData'), 'session.bin');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    return { raw: raw.toString('latin1'), plain: safeStorage.decryptString(raw) };
  });
}

/** Signs in on the web sign-in page by magic link (Mailpit) and confirms the link. */
export async function signInOnWeb(page: Page, email: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const message = await mailpit.waitForLatest(email, { timeout: 15_000 });
  const link = extractFirstLink(message);
  expect(link, 'magic link').toBeTruthy();
  await page.goto(link!);
  await page.getByRole('button', { name: 'Continue to Oat' }).click();
}

export async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  // Hide the Next.js dev indicator on web pages.
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

export function writeEvidence(name: string, data: unknown) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(`${EVIDENCE}${name}`, `${JSON.stringify(data, null, 2)}\n`);
}
