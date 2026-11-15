/**
 * Task 9.2 e2e: first-run setup, on fixtures only — permission states from a JSON file
 * (`OAT_PERMISSIONS=fixture:…`: "Allow" answers in memory, never a macOS prompt, never the sidecar), the Mac
 * calendar from a fixture without access (`OAT_CALENDAR=fixture:…`, granted in memory), the test recording from
 * FileSource (`OAT_AUDIO_SOURCE=file:…`, no devices) against the mock STT. `shell.openExternal` is stubbed
 * (helpers.ts), so neither the browser nor System Settings opens.
 *
 * 1. Fresh profile → sign in → setup opens: Allow microphone → Allow system audio → Allow calendars + "Connect
 *    Google Calendar" (opens the web integrations page) → a 10 s test recording shows levels for Me and Them and
 *    a live transcript line, saves nothing → Finish → the first-meeting guide → "Got it". A relaunch goes
 *    straight to the app; Settings → Setup shows the states and reopens the walkthrough.
 * 2. A denied microphone shows how to fix it in System Settings; "Open System Settings" opens the
 *    `x-apple.systempreferences:` Microphone pane. "Set up later" leaves setup for good.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import { evidence, launchApp, openedUrls, scaled, signInDesktop } from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

let dir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;

test.beforeAll(({ baseURL }) => {
  webUrl = baseURL!;
  dir = mkdtempSync(join(tmpdir(), 'oat-onboarding-e2e-'));
  writeFileSync(
    join(dir, 'permissions-fresh.json'),
    JSON.stringify({ microphone: 'not_determined', system_audio: 'not_determined' }),
  );
  writeFileSync(
    join(dir, 'permissions-denied.json'),
    JSON.stringify({ microphone: 'denied', system_audio: 'granted' }),
  );
  writeFileSync(
    join(dir, 'calendar.json'),
    JSON.stringify({ access: 'not_determined', events: [] }),
  );
});

test.afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function launch(profile: string, permissions: string) {
  await app?.close();
  ({ app, page } = await launchApp(join(dir, profile), webUrl, {
    OAT_ONBOARDING: 'auto',
    OAT_PERMISSIONS: `fixture:${join(dir, permissions)}`,
    OAT_CALENDAR: `fixture:${join(dir, 'calendar.json')}`,
    OAT_AUDIO_SOURCE: 'file:standup-short',
  }));
  return app!;
}

/** Light + dark screenshots of the current screen (evidence/9.2, `E2E_SCREENSHOTS=1`). */
async function shots(name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await evidence(page, `${name}-${scheme}`, '9.2');
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('fresh profile: setup → permissions → test recording → finish → first-meeting guide', async ({
  browser,
}) => {
  test.setTimeout(scaled(180_000));
  const profile = 'fresh';
  const electronApp = await launch(profile, 'permissions-fresh.json');
  const email = uniqueAddress('onboarding');
  await signInDesktop(electronApp, page, browser, email);

  const setup = page.getByTestId('onboarding');
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('heading', { level: 1 })).toHaveText('Set up Oat');
  await expect(setup).toHaveAttribute('data-step', 'microphone');
  const status = page.getByTestId('permission-status');
  await expect(status).toHaveAttribute('data-state', 'ask');
  await shots('setup-microphone');

  // Microphone: asked only on the click (fixture: granted).
  await page.getByTestId('permission-allow').click();
  await expect(status).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('onboarding-next')).toHaveText('Continue');
  await page.getByTestId('onboarding-next').click();

  // System audio.
  await expect(setup).toHaveAttribute('data-step', 'system-audio');
  await expect(page.getByRole('heading', { name: 'The other side of the call' })).toBeFocused();
  await expect(status).toHaveAttribute('data-state', 'ask');
  await shots('setup-system-audio');
  await page.getByTestId('permission-allow').click();
  await expect(status).toHaveAttribute('data-state', 'done');
  await page.getByTestId('onboarding-next').click();

  // Calendar: the Mac's calendars (fixture grant) + Google through the web app.
  await expect(setup).toHaveAttribute('data-step', 'calendar');
  await expect(page.getByTestId('calendar-mac').getByTestId('permission-status')).toHaveAttribute(
    'data-state',
    'ask',
  );
  await shots('setup-calendar');
  await page.getByTestId('calendar-mac').getByTestId('permission-allow').click();
  await expect(page.getByTestId('calendar-mac').getByTestId('permission-status')).toHaveAttribute(
    'data-state',
    'done',
  );
  await page.getByTestId('calendar-connect-google').click();
  await expect
    .poll(() => openedUrls(electronApp))
    .toContain(new URL('/settings/integrations', webUrl).toString());
  await page.getByTestId('onboarding-next').click();

  // Test recording: levels for Me and Them, a live transcript line, nothing saved.
  await expect(setup).toHaveAttribute('data-step', 'test');
  await expect(page.getByTestId('onboarding-finish')).toHaveText('Finish without a test');
  await shots('setup-test-idle');
  await page.getByTestId('test-start').click();
  const recorder = page.getByTestId('test-recording');
  await expect(recorder).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('test-level-mic')).toHaveAttribute('data-heard', 'true');
  await expect(page.getByTestId('test-level-system')).toHaveAttribute('data-heard', 'true');
  await expect(page.getByTestId('test-line')).not.toHaveText(/Listening|What Oat hears/);
  await expect(page.getByTestId('test-line')).toHaveText(/^(Me|Them)\s*\S+/);
  // Nothing can be skipped or left mid-test.
  await expect(page.getByTestId('onboarding-finish')).toBeDisabled();
  await shots('setup-test-running');
  await expect(recorder).toHaveAttribute('data-status', 'done', { timeout: scaled(30_000) });
  await expect(page.getByTestId('test-elapsed')).toHaveText(/0:(09|10) \/ 0:10/);
  await expect(page.getByTestId('test-verdict')).toHaveAttribute('data-tone', 'ok');
  await shots('setup-test-done');
  // No meeting note, no audio on disk.
  const notes = await page.evaluate(() => window.oat.invoke('meetings:list'));
  expect(notes).toMatchObject({ ok: true, value: { notes: [] } });
  const audioDir = join(dir, profile, 'audio');
  expect(existsSync(audioDir) ? readdirSync(audioDir) : []).toEqual([]);

  // Finish → the first-meeting guide on the home view.
  await expect(page.getByTestId('onboarding-finish')).toHaveText('Finish setup');
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  const guide = page.getByTestId('first-meeting-guide');
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('heading', { name: 'Your first meeting' })).toBeVisible();
  await shots('guide');
  await page.getByTestId('guide-dismiss').click();
  await expect(guide).toBeHidden();
  await expect(page.getByTestId('meeting-start')).toBeVisible();

  // Relaunch: straight into the app, no guide.
  await launch(profile, 'permissions-fresh.json');
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await expect(page.getByTestId('onboarding')).toBeHidden();
  await expect(page.getByTestId('meeting-start')).toBeVisible();

  // Settings → Setup: states at a glance; "Open setup" runs it again (all allowed: opens at the test).
  await page.getByRole('button', { name: 'Settings' }).click();
  // The fixture's grants were in memory: after the relaunch macOS (the fixture file) says "not asked" again.
  await expect(page.getByTestId('setup-microphone')).toHaveAttribute('data-state', 'ask');
  await shots('settings-setup');
  await page.getByTestId('open-setup').click();
  // (A new window after the relaunch: `setup` above belongs to the old one.)
  const again = page.getByTestId('onboarding');
  await expect(again).toBeVisible();
  await expect(again.getByRole('heading', { level: 1 })).toHaveText('Setup');
  await page.getByTestId('onboarding-later').click();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  // A re-run doesn't bring the guide back.
  await expect(page.getByTestId('first-meeting-guide')).toBeHidden();
});

test('denied microphone: how to fix it in System Settings; "Set up later" leaves setup', async ({
  browser,
}) => {
  const electronApp = await launch('denied', 'permissions-denied.json');
  const email = uniqueAddress('onboarding-denied');
  await signInDesktop(electronApp, page, browser, email);

  await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'microphone');
  await expect(page.getByTestId('permission-status')).toHaveAttribute('data-state', 'blocked');
  // macOS won't ask again: no "Allow", but where to turn it on.
  await expect(page.getByTestId('permission-allow')).toBeHidden();
  const fix = page.getByTestId('permission-blocked');
  await expect(fix).toContainText('Privacy & Security → Microphone');
  await shots('setup-microphone-denied');
  await fix.getByTestId('permission-open-settings').click();
  await expect
    .poll(() => openedUrls(electronApp))
    .toContain('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');

  // Skipping is always possible; the granted system audio shows as done.
  await expect(page.getByTestId('onboarding-next')).toHaveText('Skip for now');
  await page.getByTestId('onboarding-next').click();
  await expect(page.getByTestId('permission-status')).toHaveAttribute('data-state', 'done');

  await page.getByTestId('onboarding-later').click();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  // "Set up later" shows no guide and isn't asked again.
  await expect(page.getByTestId('first-meeting-guide')).toBeHidden();
  await launch('denied', 'permissions-denied.json');
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await expect(page.getByTestId('onboarding')).toBeHidden();
});
