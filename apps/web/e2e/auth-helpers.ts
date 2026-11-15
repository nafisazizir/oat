import { mkdirSync } from 'node:fs';

import { createMailpit, extractFirstLink, uniqueAddress } from '@oat/testkit';
import { expect, type Page } from '@playwright/test';

import { EVIDENCE_1_6 } from './paths';

const mailpit = createMailpit();

export { uniqueAddress };

/** A storage state with nothing in it: use with `test.use({ storageState: SIGNED_OUT })`. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** The newest email to `email` (Mailpit API) and its magic link, checked to point at this app. */
export async function readMagicLinkEmail(email: string, baseURL: string) {
  const message = await mailpit.waitForLatest(email, { timeout: 15_000 });
  expect(message.Subject).toBe('Sign in to Oat');
  const link = extractFirstLink(message);
  expect(link, 'magic link in email').toBeTruthy();
  // The email links to the confirm page, never straight to the verify API (link scanners).
  expect(link!.startsWith(`${baseURL}/sign-in/confirm?token=`)).toBe(true);
  return { link: link!, html: message.HTML, text: message.Text };
}

export async function readMagicLink(email: string, baseURL: string): Promise<string> {
  return (await readMagicLinkEmail(email, baseURL)).link;
}

/** Opens an emailed magic link (the confirm page) and presses "Continue to Oat". */
export async function openMagicLink(page: Page, link: string) {
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Finish signing in' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Oat' }).click();
  // POST → 303 → the target page; wait until it has fully loaded (hydrated menus etc.).
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in/confirm'), {
    waitUntil: 'load',
  });
}

/** Fills the sign-in form, waits for "Check your email", then opens and confirms the emailed link. */
export async function signInWithMagicLink(page: Page, email: string, baseURL: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByTestId('magic-link-sent')).toContainText(email);
  const link = await readMagicLink(email, baseURL);
  await openMagicLink(page, link);
  return link;
}

/**
 * "Continue with Google" → the mock issuer's login page (docker/oauth) → back to the app. The mock
 * page is a plain form; filling it is the same form post tests do without a browser.
 */
export async function signInWithGoogle(page: Page, email: string, name: string) {
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForURL(/localhost:18089\/google\/authorize/);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Screenshot for docs/tasks/evidence/1.6 — only when `E2E_SCREENSHOTS` is set (tracked files). */
export async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_1_6, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_1_6}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}
