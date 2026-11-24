/**
 * Task 7.5 e2e: auto-stop + auto-enhance, on fixtures only — calendar events from a JSON file
 * (`OAT_CALENDAR=fixture:…`), the mic-using apps from a JSON file the test rewrites (`OAT_DETECTION=file:…`: a
 * call "ends" when the test empties it; never Core Audio), audio from FileSource. Rule timings are shortened
 * (`OAT_AUTO_STOP`: 3 s floor, 2 s confirmation, 8 s undo window, 4 s silence; `OAT_END_GRACE_MS` 10 s); the agents server
 * (8.3) runs the post-meeting pipeline against the mock LLM.
 *
 * 1. Zoom takes the mic during "Weekly sync" → Start notes → Zoom lets go near the event's end → "Stopping the
 *    recording in … s" toast → stopped → "Post-meeting steps in … s" → the header shows the pipeline running
 *    and then "Post-meeting: done"; the server ran enhance.
 * 2. Undo: the toast's "Keep recording" keeps recording past the undo window. Stopped by hand, "Continue
 *    recording" within the grace period → recording again, the meeting never ended and no pipeline run exists;
 *    stopped again, "Start now" ends it at once and the run is created.
 * 3. In-person silence → "Meeting over?" → "Keep going"; the Recording settings switch.
 * 4. The app is killed inside the grace period: the relaunch ends the meeting and its pipeline run starts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CalendarEventInput } from '@oat/core';
import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { databaseUrlFile } from '../../web/e2e/paths';
import {
  evidence,
  launchApp,
  openTranscript,
  stopRecording,
  scaled,
  signInDesktop,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

const MIN = 60_000;
const ZOOM = [{ pid: 501, bundleId: 'us.zoom.xos' }];
const UNDO_MS = 8_000;
const GRACE_MS = 10_000;

let dir: string;
let appsFile: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
let sql: postgres.Sql;
const email = uniqueAddress('auto-stop');

const ENV = {
  OAT_AUDIO_SOURCE: 'file:one-on-one',
  get OAT_CALENDAR() {
    return `fixture:${join(dir, 'calendar.json')}`;
  },
  get OAT_DETECTION() {
    return `file:${appsFile}`;
  },
  // The fixture keeps playing both voices after a "call" ends, so the "other side still talking" check is off
  // (`speechDb` 0 dBFS: never reached); fixtures cover it.
  OAT_AUTO_STOP: JSON.stringify({
    floorMs: 3000,
    confirmMs: 2000,
    undoMs: UNDO_MS,
    silenceMs: 4000,
    speechDb: 0,
  }),
  OAT_END_GRACE_MS: String(GRACE_MS),
};

const micApps = (apps: typeof ZOOM | []) => writeFileSync(appsFile, JSON.stringify(apps));

/** "Weekly sync": started 10 min ago (current: the prompt names it), ends in 4 min (a call ending now is "over"). */
function writeCalendar() {
  const now = Date.now();
  const event: CalendarEventInput = {
    id: 'eventkit:weekly',
    source: 'eventkit',
    calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
    title: 'Weekly sync',
    start: new Date(now - 10 * MIN).toISOString(),
    end: new Date(now + 4 * MIN).toISOString(),
    allDay: false,
    allDayStart: null,
    allDayEnd: null,
    timeZone: null,
    location: null,
    url: null,
    conferenceUrl: 'https://us02web.zoom.us/j/81234567890',
    conferenceProvider: 'zoom',
    status: 'confirmed',
    attendees: [
      { name: 'Me', email: 'me@oat.test', status: 'accepted', isSelf: true, isOrganizer: false },
      {
        name: 'Jordan Lee',
        email: 'jordan@oat.test',
        status: 'accepted',
        isSelf: false,
        isOrganizer: true,
      },
    ],
    recurrenceId: null,
    icalUid: 'weekly@oat.test',
  };
  writeFileSync(join(dir, 'calendar.json'), JSON.stringify([event]));
}

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  dir = mkdtempSync(join(tmpdir(), 'oat-desktop-autostop-'));
  appsFile = join(dir, 'apps.json');
  micApps([]);
  writeCalendar();
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/calendar/upcoming`);
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/documents/warmup/pipeline`);
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});

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

async function shots(p: Page, name: string, both = true) {
  if (!process.env.E2E_SCREENSHOTS) return;
  for (const scheme of both ? (['light', 'dark'] as const) : (['light'] as const)) {
    await p.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(p.locator('html')).toHaveClass(/dark/);
    else await expect(p.locator('html')).not.toHaveClass(/dark/);
    await evidence(p, `${name}-${scheme}`, '7.5');
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

const notifications = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() =>
    (
      (globalThis as { __oatNotifications?: { title: string; closed: boolean }[] })
        .__oatNotifications ?? []
    ).map(({ title, closed }) => ({ title, closed })),
  );

const bar = () => page.getByTestId('recording-bar');
/** The open note's transcript lines (its panel is opened first: closed by default in the calm shell). */
async function segments() {
  return (await openTranscript(page)).locator('[data-testid=transcript-segment]');
}

async function synced() {
  await expect
    .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
      timeout: scaled(30_000),
    })
    .toBe(0);
}

test('the call ends near its event’s end → toast → stopped → grace → Post-meeting: done', async ({
  browser,
}) => {
  test.setTimeout(scaled(240_000));
  ({ app, page } = await launchApp(join(dir, 'profile'), webUrl, ENV));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  await signInDesktop(app, page, browser, email);

  // Zoom takes the mic during "Weekly sync": Start notes → the event's note records.
  micApps(ZOOM);
  const prompt = page.getByTestId('meeting-prompt');
  await expect(prompt).toContainText('Start notes for Weekly sync?', { timeout: scaled(20_000) });
  await prompt.getByRole('button', { name: 'Start notes' }).click();
  await expect(bar()).toHaveAttribute('data-status', 'recording', { timeout: scaled(20_000) });
  await expect(page.getByTestId('note-title')).toHaveValue('Weekly sync');
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  // A few lines of transcript (the e2e agents want ≥ 5 s of speech to auto-enhance).
  await expect((await segments()).nth(2)).toBeVisible({ timeout: scaled(30_000) });

  // Zoom lets go of the mic, 4 min before the event ends: clearly over → the undo toast.
  micApps([]);
  const toast = page.getByTestId('autostop-toast');
  await expect(toast).toBeVisible({ timeout: scaled(10_000) });
  await expect(toast).toHaveAttribute('data-reason', 'meeting_ended');
  await expect(toast).toContainText('Stopping the recording in');
  await expect(toast.getByRole('button', { name: 'Keep recording' })).toBeVisible();
  expect(await notifications(app)).toContainEqual({
    title: 'Stopping the recording',
    closed: false,
  });
  await shots(page, 'desktop-autostop-toast');

  // Nobody undoes it: stopped when the window runs out.
  await expect(bar()).toHaveAttribute('data-status', 'idle', { timeout: scaled(UNDO_MS + 30_000) });
  await expect(toast).toHaveCount(0);

  // The grace period: the meeting's end isn't written yet.
  const graceLine = page.getByTestId('meeting-grace');
  await expect(graceLine).toContainText('Post-meeting steps in');
  await expect(graceLine.getByRole('button', { name: 'Start now' })).toBeVisible();
  // One "Continue recording": the recording bar's.
  await expect(page.getByRole('button', { name: 'Continue recording' })).toHaveCount(1);
  await shots(page, 'desktop-grace');

  // Then the pipeline: the header follows it to "done".
  const status = page.getByTestId('pipeline-status');
  const seen: string[] = [];
  await expect
    .poll(
      async () => {
        const s = await status.getAttribute('data-status', { timeout: 500 }).catch(() => null);
        const step = await status.getAttribute('data-step', { timeout: 500 }).catch(() => null);
        const label = s ? `${s}${step ? `:${step}` : ''}` : null;
        if (label && seen.at(-1) !== label) seen.push(label);
        return s;
      },
      { timeout: scaled(120_000), intervals: [200] },
    )
    .toBe('completed');
  await expect(status).toContainText('Post-meeting: done');
  await expect(graceLine).toHaveCount(0);
  await shots(page, 'desktop-post-meeting-done');
  writeEvidence('pipeline-statuses.json', { meetingId, seen }, '7.5');
  // The header showed it on its way (not only the end state).
  expect(seen.length).toBeGreaterThan(1);

  const [run] = await sql<{ status: string; steps: { step: string; outcome: string }[] }[]>`
    select status, steps from pipeline_run where meeting_id = ${meetingId}`;
  expect(run?.status).toBe('completed');
  expect(run!.steps.find((s) => s.step === 'enhance')?.outcome).toBe('ran');
  const [meeting] = await sql<{ ended_at: Date | null }[]>`
    select ended_at from meeting where id = ${meetingId}`;
  expect(meeting!.ended_at).not.toBeNull();
});

test('undo keeps recording; Continue recording within the grace period starts no run', async () => {
  test.setTimeout(scaled(180_000));
  // Zoom is in a call again, then notes start (a new note; the call was going before the recording).
  micApps(ZOOM);
  // This event has already been prompted. Give the fixture's 100 ms poll and the detector's
  // 2 s eligibility delay time to recognize the call before starting the recording.
  await page.waitForTimeout(scaled(3_000));
  await page.getByTestId('new-meeting').click();
  await expect(bar()).toHaveAttribute('data-status', 'recording', { timeout: scaled(20_000) });
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  await expect((await segments()).first()).toBeVisible({ timeout: scaled(30_000) });

  // The call ends → toast → "Keep recording": still recording well past the undo window.
  micApps([]);
  const toast = page.getByTestId('autostop-toast');
  await expect(toast).toBeVisible({ timeout: scaled(10_000) });
  await toast.getByRole('button', { name: 'Keep recording' }).click();
  await expect(toast).toHaveCount(0);
  // What is checked here is that nothing happens for a while: let the undo window pass.
  await page.waitForTimeout(UNDO_MS + 2_000);
  await expect(bar()).toHaveAttribute('data-status', 'recording');
  expect((await invoke<{ status: string }>(page, 'recording:get')).status).toBe('recording');

  // Stopped by hand → grace → "Continue recording": the meeting goes on, it never ended.
  await stopRecording(page);
  await expect(bar()).toHaveAttribute('data-status', 'idle', { timeout: scaled(30_000) });
  const graceLine = page.getByTestId('meeting-grace');
  await expect(graceLine).toBeVisible();
  await bar().getByRole('button', { name: 'Continue recording' }).click();
  await expect(bar()).toHaveAttribute('data-status', 'recording', { timeout: scaled(20_000) });
  await expect(graceLine).toHaveCount(0);
  expect((await invoke<{ meetingId: string }>(page, 'recording:get')).meetingId).toBe(meetingId);
  await synced();
  // Past when the grace period would have ended (nothing happens: let the time pass), still no end and no
  // run on the server.
  await page.waitForTimeout(GRACE_MS + 2_000);
  await synced();
  const [m] = await sql<{ ended_at: Date | null; started_at: Date | null }[]>`
    select ended_at, started_at from meeting where id = ${meetingId}`;
  expect(m).toMatchObject({ started_at: expect.any(Date), ended_at: null });
  expect(await sql`select id from pipeline_run where meeting_id = ${meetingId}`).toHaveLength(0);

  // Stopped again → "Start now": the end is written at once and the run is created.
  await stopRecording(page);
  await expect(bar()).toHaveAttribute('data-status', 'idle', { timeout: scaled(30_000) });
  await graceLine.getByRole('button', { name: 'Start now' }).click();
  await expect(graceLine).toHaveCount(0);
  await synced();
  await expect
    .poll(
      async () => (await sql`select id from pipeline_run where meeting_id = ${meetingId}`).length,
      { timeout: scaled(30_000) },
    )
    .toBe(1);
});

test('in-person silence → "Meeting over?" → Keep going; the Recording settings', async () => {
  test.setTimeout(scaled(120_000));
  micApps([]);
  // silence-gap: two lines, then 10 s of silence (the shortened silence fallback is 4 s).
  await invoke(page, 'recording:start', { input: 'file', fixture: 'silence-gap' });
  await expect(bar()).toHaveAttribute('data-status', 'recording', { timeout: scaled(20_000) });
  const question = page.getByTestId('autostop-question');
  await expect(question).toBeVisible({ timeout: scaled(30_000) });
  await expect(question).toHaveAttribute('data-reason', 'silence');
  await expect(question).toContainText('Meeting over?');
  await expect(page.getByTestId('autostop-toast')).toHaveCount(0); // in-person: never stopped by itself
  await shots(page, 'desktop-autostop-question');
  await question.getByRole('button', { name: 'Keep going' }).click();
  await expect(question).toHaveCount(0);
  await expect(bar()).toHaveAttribute('data-status', 'recording');
  await stopRecording(page);
  await expect(bar()).toHaveAttribute('data-status', 'idle', { timeout: scaled(30_000) });

  // Settings → Recording: on by default; switching it off is kept (per Mac).
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.getByTestId('settings-section-recording').click();
  const settings = page.getByTestId('recording-settings');
  const enabled = settings.getByTestId('autostop-enabled');
  await expect(enabled).toBeChecked();
  await expect(settings.getByTestId('autostop-in-person')).not.toBeChecked();
  await shots(page, 'desktop-recording-settings', false);
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(settings.getByTestId('autostop-in-person')).toBeDisabled();
  expect(await invoke(page, 'autostop:get-settings')).toEqual({ enabled: false, inPerson: false });
  await enabled.click();
  await expect(enabled).toBeChecked();
  expect(await invoke(page, 'autostop:get-settings')).toEqual({ enabled: true, inPerson: false });
});

test('a crash inside the grace period: the relaunch ends the meeting and the pipeline runs', async () => {
  test.setTimeout(scaled(180_000));
  await page.getByTestId('settings-close').click();
  await page.getByTestId('new-meeting').click();
  await expect(bar()).toHaveAttribute('data-status', 'recording', { timeout: scaled(20_000) });
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  await expect((await segments()).nth(2)).toBeVisible({ timeout: scaled(30_000) });
  await stopRecording(page);
  await expect(bar()).toHaveAttribute('data-status', 'idle', { timeout: scaled(30_000) });
  await expect(page.getByTestId('meeting-grace')).toBeVisible();
  await synced();

  // The process dies inside the grace period: nothing gets to write the end.
  app!.process().kill('SIGKILL');
  app = undefined;
  const [before] = await sql<{ ended_at: Date | null }[]>`
    select ended_at from meeting where id = ${meetingId}`;
  expect(before!.ended_at).toBeNull();

  // Relaunched (still signed in): the held end is written once the account's database is open → synced →
  // the post-meeting run is created.
  ({ app, page } = await launchApp(join(dir, 'profile'), webUrl, ENV));
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await expect
    .poll(
      async () => {
        const [m] = await sql<{ ended_at: Date | null }[]>`
          select ended_at from meeting where id = ${meetingId}`;
        const runs = await sql`select id from pipeline_run where meeting_id = ${meetingId}`;
        return { ended: m?.ended_at != null, runs: runs.length };
      },
      { timeout: scaled(GRACE_MS + 60_000) },
    )
    .toEqual({ ended: true, runs: 1 });
});
