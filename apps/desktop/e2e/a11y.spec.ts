/**
 * Task 9.3b: the desktop design sweep + axe scan. One user walks every renderer screen — sign-in, first-run
 * setup (each step, a finished test recording), the first-meeting guide, the "Start notes?" banner, a live
 * recording with the widget, a recorded note with a task list and its transcript, local search, an upcoming
 * event's note, Settings — and each screen is scanned with axe-core in light and dark (contrast differs):
 * no `serious`/`critical` violation of WCAG 2.x A/AA or axe best practices may remain (KNOWN aside).
 *
 * Fixtures only (FACTORY §4): permissions from a JSON file, calendar events + a Zoom "call" in process, audio from
 * FileSource, the mock STT. `E2E_SCREENSHOTS=1` also writes the sweep (`docs/tasks/evidence/9.2/sweep/after/`,
 * or `E2E_SWEEP_DIR`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import { launchApp, scaled, signInDesktop } from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');

type Finding = {
  screen: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
  /** axe's explanation per target (e.g. the colours and the ratio). */
  details: string[];
};

/** Known findings, each with a reason in docs/tasks/9.2-onboarding.md (punch list). Keep it specific. */
const KNOWN: { id: string; target: RegExp; why: string }[] = [];

const SWEEP_DIR =
  process.env.E2E_SWEEP_DIR ??
  fileURLToPath(new URL('../../../docs/tasks/evidence/9.2/sweep/after/', import.meta.url));

let dir: string;
let app: ElectronApplication | undefined;
let page: Page;
const findings: Finding[] = [];

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oat-a11y-e2e-'));
});
test.afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function scan(p: Page, screen: string) {
  await p.evaluate(() => document.fonts.ready);
  // Legacy mode: axe runs in the page itself (no extra blank page, which Electron can't open).
  const { violations } = await new AxeBuilder({ page: p })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  for (const v of violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    const nodes = v.nodes.filter(
      (n) => !KNOWN.some((k) => k.id === v.id && k.target.test(n.target.join(' '))),
    );
    if (nodes.length > 0) {
      findings.push({
        screen,
        id: v.id,
        impact: v.impact,
        help: v.help,
        targets: nodes.slice(0, 5).map((n) => n.target.join(' ')),
        details: nodes
          .slice(0, 5)
          .map((n) => `${n.html.slice(0, 160)} → ${n.failureSummary ?? ''}`),
      });
    }
  }
}

/** Scans (and, with `E2E_SCREENSHOTS=1`, screenshots) the screen in light and dark. */
async function sweep(p: Page, name: string) {
  await p.mouse.move(1, 1);
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(p.locator('html')).toHaveClass(/dark/);
    else await expect(p.locator('html')).not.toHaveClass(/dark/);
    // Colour transitions (badges, buttons) finish first: axe must see the resting colours.
    await p.waitForTimeout(400);
    await scan(p, `${name} (${scheme})`);
    if (process.env.E2E_SCREENSHOTS) {
      mkdirSync(SWEEP_DIR, { recursive: true });
      await p.screenshot({ path: join(SWEEP_DIR, `${name}-${scheme}.png`) });
    }
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

const MIN = 60_000;

function writeFixtures() {
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const attendee = (name: string, email: string, isSelf = false) => ({
    name,
    email,
    status: 'accepted',
    isSelf,
    isOrganizer: !isSelf,
  });
  const event = (id: string, title: string, start: Date, minutes: number, extra = {}) => ({
    id: `eventkit:${id}`,
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * MIN).toISOString(),
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: null,
    location: null,
    url: null,
    conferenceUrl: null,
    conferenceProvider: null,
    status: 'confirmed',
    attendees: [attendee('Me', 'me@oat.test', true), attendee('Jordan Lee', 'jordan@oat.test')],
    recurrenceId: null,
    icalUid: `${id}@oat.test`,
    ...extra,
  });
  writeFileSync(
    join(dir, 'calendar.json'),
    JSON.stringify({
      access: 'not_determined',
      events: [
        event('review', 'Design review', new Date(now - 5 * MIN), 40, {
          conferenceUrl: 'https://us02web.zoom.us/j/81234567890',
          conferenceProvider: 'zoom',
        }),
        event('one-on-one', '1:1 with Sam', tomorrow, 30),
      ],
    }),
  );
  writeFileSync(
    join(dir, 'permissions.json'),
    JSON.stringify({ microphone: 'not_determined', system_audio: 'denied' }),
  );
  // Zoom takes the mic shortly after setup is done (detection starts at sign-in).
  writeFileSync(join(dir, 'apps.json'), '[]');
}

test('every desktop screen: axe clean in light and dark (+ sweep screenshots)', async ({
  baseURL,
  browser,
}) => {
  test.setTimeout(scaled(300_000));
  writeFixtures();
  ({ app, page } = await launchApp(join(dir, 'profile'), baseURL!, {
    OAT_ONBOARDING: 'auto',
    OAT_PERMISSIONS: `fixture:${join(dir, 'permissions.json')}`,
    OAT_CALENDAR: `fixture:${join(dir, 'calendar.json')}`,
    OAT_DETECTION: `file:${join(dir, 'apps.json')}`,
    OAT_AUDIO_SOURCE: 'file:standup-short',
    OAT_TEST_RECORDING_MS: '3000',
  }));
  const electronApp = app!;

  // Signed out.
  await expect(page.getByRole('heading', { name: 'Welcome to Oat' })).toBeVisible();
  await sweep(page, '01-welcome');
  const email = uniqueAddress('a11y');
  await signInDesktop(electronApp, page, browser, email);

  // First-run setup.
  const setup = page.getByTestId('onboarding');
  await expect(setup).toHaveAttribute('data-step', 'microphone');
  await sweep(page, '02-setup-microphone');
  await page.getByTestId('permission-allow').click();
  await page.getByTestId('onboarding-next').click();
  await expect(setup).toHaveAttribute('data-step', 'system-audio');
  await sweep(page, '03-setup-system-audio-denied');
  await page.getByTestId('onboarding-next').click();
  await expect(setup).toHaveAttribute('data-step', 'calendar');
  await sweep(page, '04-setup-calendar');
  await page.getByTestId('calendar-mac').getByTestId('permission-allow').click();
  await page.getByTestId('onboarding-next').click();
  await expect(setup).toHaveAttribute('data-step', 'test');
  await page.getByTestId('test-start').click();
  await expect(page.getByTestId('test-recording')).toHaveAttribute('data-status', 'done', {
    timeout: scaled(30_000),
  });
  await sweep(page, '05-setup-test-done');
  await page.getByTestId('onboarding-finish').click();

  // Home with the first-meeting guide.
  await expect(page.getByTestId('first-meeting-guide')).toBeVisible();
  await sweep(page, '06-home-guide');
  await page.getByTestId('guide-dismiss').click();
  await expect(page.getByTestId('meeting-start')).toBeVisible();
  await sweep(page, '07-home');

  // "Start notes?" when Zoom takes the mic during "Design review".
  writeFileSync(join(dir, 'apps.json'), JSON.stringify([{ pid: 501, bundleId: 'us.zoom.xos' }]));
  const banner = page.getByTestId('meeting-prompt');
  await expect(banner).toBeVisible({ timeout: scaled(20_000) });
  await sweep(page, '08-prompt');
  await banner.getByRole('button', { name: 'Not now' }).click();
  await expect(banner).toBeHidden();
  writeFileSync(join(dir, 'apps.json'), '[]');

  // A live recording, and the widget.
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const notes = page.getByRole('textbox', { name: 'My notes' });
  await notes.click();
  await page.keyboard.type('Decisions');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[ ] Send the launch checklist');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ask Jordan about the beta');
  await expect(
    page.locator('[data-testid="transcript-panel"] [data-segment-id]').first(),
  ).toBeVisible({
    timeout: scaled(20_000),
  });
  await sweep(page, '09-recording');
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-recording')).toHaveText('Recording');
  await sweep(widget, '10-widget-recording');
  await widget.getByRole('button', { name: 'Close widget' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });

  // The recorded note (task list, transcript, player, post-meeting line).
  await expect(page.getByRole('button', { name: 'Continue recording' })).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  await sweep(page, '11-note-recorded');

  // Local search.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByLabel('Search notes and transcripts on this Mac');
  await search.fill('launch');
  await expect(page.getByTestId('local-search-results')).toBeVisible();
  await sweep(page, '12-search');
  await search.fill('');
  await page.keyboard.press('Escape');

  // An upcoming event's note (not recorded yet).
  await page
    .getByTestId('upcoming')
    .getByTestId('upcoming-event')
    .filter({ hasText: '1:1 with Sam' })
    .click();
  await expect(page.getByTestId('note-title')).toHaveValue('1:1 with Sam');
  await sweep(page, '13-note-upcoming');

  // Settings.
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await sweep(page, '14-settings-preferences');
  await page.getByTestId('settings-section-recording').click();
  await sweep(page, '14-settings-recording');
  await page.getByTestId('settings-section-storage').click();
  await expect(page.getByTestId('storage-total')).toBeVisible();
  await sweep(page, '14-settings-storage');

  // Signed out again (account card after sign-out).
  await page.getByTestId('settings-close').click();
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Oat' })).toBeVisible();

  // The whole list, for the punch list (git-ignored).
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/a11y-findings.json', `${JSON.stringify(findings, null, 2)}\n`);
  expect(
    findings.map(({ details: _details, ...f }) => f),
    JSON.stringify(findings, null, 2),
  ).toEqual([]);
});
