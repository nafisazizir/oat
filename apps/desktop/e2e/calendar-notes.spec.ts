/**
 * Task 7.3 e2e: meeting notes from calendar events + the "Start notes?" prompt, on fixtures only — calendar
 * events from a JSON file (`OAT_CALENDAR=fixture:…`, in process: never EventKit), the mic-apps signal from a
 * detection timeline (`OAT_DETECTION=fixture:…`, in process: never Core Audio), audio from FileSource.
 *
 * 1. Signed in, the sidebar lists today's and tomorrow's events. Zoom "takes the mic" during "Design review":
 *    the banner (and a recorded native notification) asks "Start notes for Design review?" → Start notes →
 *    the note is made from the event (title, attendees, scheduled time + Join link) and records into it;
 *    after sync Postgres has the meeting key and the calendar attendees.
 * 2. "Upcoming" → tomorrow's event → its note opens (not recorded yet); clicking again reopens the same one.
 * 3. A Mac calendar without access shows "Connect calendar" (nothing asked on its own); clicking it (a fixture
 *    grant, no macOS prompt) lists the events.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CalendarEventInput } from '@oat/core';
import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { databaseUrlFile } from '../../web/e2e/paths';
import { evidence, launchApp, scaled, signInDesktop } from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

const FIXTURE = 'standup-short';

let dir: string;
let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
let sql: postgres.Sql;
const email = uniqueAddress('calendar-notes');

const MIN = 60_000;
const attendees = (...others: [string, string][]) => [
  {
    name: 'Me',
    email: 'me@oat.test',
    status: 'accepted' as const,
    isSelf: true,
    isOrganizer: false,
  },
  ...others.map(([name, address], i) => ({
    name,
    email: address,
    status: 'accepted' as const,
    isSelf: false,
    isOrganizer: i === 0,
  })),
];

function event(
  id: string,
  title: string,
  start: Date,
  minutes: number,
  extra: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  return {
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
    attendees: attendees(['Jordan Lee', 'jordan@oat.test']),
    recurrenceId: null,
    icalUid: `${id}@oat.test`,
    ...extra,
  };
}

let tomorrowTitle: string;

/** Today's in-progress review (Zoom) and a 1:1 tomorrow at 10:00, local time. */
function writeFixtures() {
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  tomorrowTitle = '1:1 with Sam';
  const events = [
    event('review', 'Design review', new Date(now - 5 * MIN), 40, {
      conferenceUrl: 'https://us02web.zoom.us/j/81234567890',
      conferenceProvider: 'zoom',
      attendees: attendees(['Jordan Lee', 'jordan@oat.test'], ['Priya Nair', 'priya@oat.test']),
    }),
    event('one-on-one', tomorrowTitle, tomorrow, 30, {
      attendees: attendees(['Sam Okafor', 'sam@oat.test']),
    }),
  ];
  writeFileSync(join(dir, 'calendar.json'), JSON.stringify(events));
  writeFileSync(
    join(dir, 'calendar-no-access.json'),
    JSON.stringify({ access: 'not_determined', events }),
  );
  // Zoom holds the mic from 3 s after detection starts (sign-in) until the end of the test.
  writeFileSync(
    join(dir, 'zoom.json'),
    JSON.stringify({
      steps: [
        { at: 0, micApps: [] },
        { at: 3_000, micApps: [{ pid: 501, bundleId: 'us.zoom.xos' }] },
      ],
    }),
  );
}

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  dir = mkdtempSync(join(tmpdir(), 'oat-desktop-calendar-'));
  userDataDir = join(dir, 'profile');
  writeFixtures();
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/calendar/upcoming`);
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: { origin: webUrl } });
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});

async function launch(env: Record<string, string>) {
  await app?.close();
  ({ app, page } = await launchApp(userDataDir, webUrl, {
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
    ...env,
  }));
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  return app!;
}

const invoke = <T>(p: Page, channel: string, payload?: unknown) =>
  p.evaluate(
    async ([c, body]) => {
      const oat = window.oat as unknown as {
        invoke(
          c: string,
          b?: unknown,
        ): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
      };
      const r = body === undefined ? await oat.invoke(c) : await oat.invoke(c, body);
      if (!r.ok) throw new Error(r.error!.message);
      return r.value;
    },
    [channel, payload] as const,
  ) as Promise<T>;

async function shots(p: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(p.locator('html')).toHaveClass(/dark/);
    else await expect(p.locator('html')).not.toHaveClass(/dark/);
    await evidence(p, `${name}-${scheme}`, '7.3');
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

const notifications = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() =>
    (
      (globalThis as { __oatNotifications?: { title: string; body: string; closed: boolean }[] })
        .__oatNotifications ?? []
    ).map(({ title, body, closed }) => ({ title, body, closed })),
  );

test('detected call during an event → "Start notes?" → note from the event, recording', async ({
  browser,
}) => {
  test.setTimeout(scaled(180_000));
  const electronApp = await launch({
    OAT_CALENDAR: `fixture:${join(dir, 'calendar.json')}`,
    OAT_DETECTION: `fixture:${join(dir, 'zoom.json')}`,
  });
  await signInDesktop(electronApp, page, browser, email);

  // "Upcoming": today's review (in progress) and tomorrow's 1:1; the Mac calendar is readable: no CTA.
  const upcoming = page.getByTestId('upcoming');
  await expect(upcoming.getByTestId('upcoming-event-title')).toHaveText([
    'Design review',
    tomorrowTitle,
  ]);
  await expect(upcoming.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(upcoming.getByRole('heading', { name: 'Tomorrow' })).toBeVisible();
  await expect(upcoming.getByTestId('calendar-connect')).toHaveCount(0);

  // Zoom takes the mic: the banner names the event, a native notification went out (recorded in e2e).
  const banner = page.getByTestId('meeting-prompt');
  await expect(banner).toBeVisible({ timeout: scaled(20_000) });
  await expect(banner).toHaveAttribute('data-kind', 'detected');
  await expect(banner).toContainText('Start notes for Design review?');
  await expect(banner).toContainText('Zoom is using your microphone.');
  expect(await notifications(electronApp)).toEqual([
    expect.objectContaining({ title: 'Start notes for Design review?', closed: false }),
  ]);
  await shots(page, 'desktop-prompt');

  // Start notes: the note is made from the event and records.
  await banner.getByRole('button', { name: 'Start notes' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording', {
    timeout: scaled(20_000),
  });
  await expect(page.getByTestId('note-title')).toHaveValue('Design review');
  const chips = page.getByTestId('participant-chip');
  await expect(chips).toHaveCount(2);
  // All from the calendar; order among attendees added together isn't defined.
  await expect(chips.and(page.locator('[data-source=calendar]'))).toHaveCount(2);
  for (const name of ['Jordan Lee', 'Priya Nair'])
    await expect(chips.filter({ hasText: name })).toHaveCount(1);
  const scheduled = page.getByTestId('note-calendar-event');
  await expect(scheduled).toContainText('Scheduled');
  await expect(scheduled.getByRole('button', { name: 'Join Zoom' })).toBeVisible();
  await expect(page.getByTestId('meeting-time')).toHaveAttribute('data-in-progress', 'true');
  expect((await notifications(electronApp))[0]!.closed).toBe(true);
  // The event in "Upcoming" now has its note.
  await expect(upcoming.getByTestId('upcoming-event').first()).toHaveAttribute(
    'data-has-note',
    'true',
  );
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  await expect(
    page.getByTestId('transcript-panel').locator('[data-testid=transcript-segment]').first(),
  ).toBeVisible({ timeout: scaled(20_000) });
  await shots(page, 'desktop-recording-from-event');

  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
  // No new prompt while Zoom still holds the mic (that call was already prompted, D-21).
  await expect(banner).toHaveCount(0);

  // Synced: the meeting carries the event's key and the calendar attendees.
  await expect
    .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
      timeout: scaled(30_000),
    })
    .toBe(0);
  const [row] = await sql<{ calendar_event_id: string; started_at: Date | null; title: string }[]>`
    select m.calendar_event_id, m.started_at, d.title
    from meeting m join document d on d.id = m.document_id where m.id = ${meetingId}`;
  expect(row).toMatchObject({
    calendar_event_id: expect.stringMatching(/^ical:review@oat\.test@/),
    title: 'Design review',
  });
  expect(row!.started_at).not.toBeNull();
  const people = await sql<{ name: string; source: string }[]>`
    select name, source from participant where meeting_id = ${meetingId} order by name`;
  expect(people).toEqual([
    { name: 'Jordan Lee', source: 'calendar' },
    { name: 'Priya Nair', source: 'calendar' },
  ]);
});

test('Upcoming → Start notes opens the event’s note; again reopens the same one', async () => {
  test.setTimeout(scaled(90_000));
  const upcoming = page.getByTestId('upcoming');
  const tomorrow = upcoming.getByTestId('upcoming-event').filter({ hasText: tomorrowTitle });
  await expect(tomorrow).toHaveAttribute(
    'aria-label',
    new RegExp(`^Start notes for ${tomorrowTitle}`),
  );
  const listed = await page.getByTestId('meeting-list-item').count();
  await tomorrow.click();
  await expect(page.getByTestId('note-title')).toHaveValue(tomorrowTitle);
  await expect(page.getByTestId('meeting-time')).toContainText('Not recorded yet');
  await expect(page.getByTestId('participant-chip')).toHaveCount(1);
  await expect(page.getByTestId('participant-chip')).toContainText('Sam Okafor');
  await expect(page.getByTestId('note-calendar-event')).toContainText('Scheduled');
  // Recording can start into it (nothing recorded yet): no "recorded on another device" hint.
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  await expect(page.getByText('Recorded on another device')).toHaveCount(0);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(listed + 1);
  const documentId = await page
    .getByTestId('meeting-list-item')
    .filter({ hasText: tomorrowTitle })
    .getAttribute('data-document-id');
  await shots(page, 'desktop-upcoming-note');

  // Open another note, then the event again: the same note, no second one.
  await page.getByTestId('meeting-list-item').filter({ hasText: 'Design review' }).click();
  await expect(page.getByTestId('note-title')).toHaveValue('Design review');
  await expect(tomorrow).toHaveAttribute('data-has-note', 'true');
  await tomorrow.click();
  await expect(page.getByTestId('note-title')).toHaveValue(tomorrowTitle);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(listed + 1);
  await expect(
    page.getByTestId('meeting-list-item').filter({ hasText: tomorrowTitle }),
  ).toHaveAttribute('data-document-id', documentId!);
});

test('no calendar access: "Connect calendar" (never asked on its own) → events', async () => {
  test.setTimeout(scaled(90_000));
  // Relaunch (same profile: still signed in) with a Mac calendar that hasn't been granted, detection off.
  await launch({ OAT_CALENDAR: `fixture:${join(dir, 'calendar-no-access.json')}` });
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  const upcoming = page.getByTestId('upcoming');
  const connect = upcoming.getByTestId('calendar-connect');
  await expect(connect).toContainText('See your meetings here');
  await expect(upcoming.getByTestId('upcoming-event')).toHaveCount(0);
  await shots(page, 'desktop-connect');
  await connect.getByRole('button', { name: 'Connect calendar' }).click();
  await expect(upcoming.getByTestId('upcoming-event-title')).toHaveText([
    'Design review',
    tomorrowTitle,
  ]);
  await expect(connect).toHaveCount(0);
  // Both notes made earlier are recognised.
  await expect(upcoming.getByTestId('upcoming-event').first()).toHaveAttribute(
    'data-has-note',
    'true',
  );
});
