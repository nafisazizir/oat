/**
 * Task 3.9 e2e: the desktop's workspace switcher, against `next dev` on the throwaway database. Fixtures only:
 * audio from FileSource, calendar events from a JSON file (never EventKit), no meeting detection.
 *
 * 1. Signed in, I'm added to two team workspaces (straight into Postgres, as the web's invite flow would):
 *    "Design team" as a member and "Board" as a viewer. Sync brings them (with my role) to the switcher.
 * 2. Switching to Design team filters the meeting list; "New meeting note" records into Design team (the
 *    header says so) and, synced, the server has the note there — private, mine.
 * 3. Board (viewer): the sidebar says new notes go to Personal; "Start notes" on an Upcoming event makes the
 *    note in Personal, and Upcoming says where it is.
 * 4. Demoted to viewer in Design team: the switcher follows (sync re-sends the workspace with my role) and its
 *    note becomes view-only here. The active workspace survives a relaunch (per account, local database).
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

const TASK = '3.9';
const run = Math.random().toString(36).slice(2, 7);
const DESIGN = `Design team ${run}`;
const BOARD = `Board ${run}`;
const EVENT = 'Quarterly planning';

let dir: string;
let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
let sql: postgres.Sql;
const email = uniqueAddress('desktop-workspaces');
let userId: string;
let designId: string;
let boardId: string;

function writeCalendar() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const events: CalendarEventInput[] = [
    {
      id: 'eventkit:planning',
      source: 'eventkit',
      calendar: { id: 'cal-work', title: 'Work', color: '#3B82F6' },
      title: EVENT,
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      allDay: false,
      allDayStart: null,
      allDayEnd: null,
      timeZone: null,
      location: null,
      url: null,
      conferenceUrl: null,
      conferenceProvider: null,
      status: 'confirmed',
      attendees: [],
      recurrenceId: null,
      icalUid: `planning-${run}@oat.test`,
    },
  ];
  writeFileSync(join(dir, 'calendar.json'), JSON.stringify(events));
}

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  dir = mkdtempSync(join(tmpdir(), 'oat-desktop-workspaces-'));
  userDataDir = join(dir, 'profile');
  writeCalendar();
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/events`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: { origin: webUrl } });
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(dir, { recursive: true, force: true });
});

async function launch() {
  await app?.close();
  ({ app, page } = await launchApp(userDataDir, webUrl, {
    OAT_AUDIO_SOURCE: 'file:standup-short',
    OAT_CALENDAR: `fixture:${join(dir, 'calendar.json')}`,
    OAT_DETECTION: 'off',
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

const synced = () =>
  expect
    .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
      timeout: scaled(30_000),
    })
    .toBe(0);

/** A team workspace with me in it at `role` (what accepting an invite does). */
async function joinTeam(name: string, role: 'member' | 'viewer'): Promise<string> {
  const id = `ws-${run}-${role}`;
  await sql.begin(async (tx) => {
    await tx`insert into workspace (id, name, slug, kind, created_by)
             values (${id}, ${name}, ${id}, 'team', ${userId})`;
    await tx`insert into membership (id, workspace_id, user_id, role)
             values (${`m-${id}`}, ${id}, ${userId}, ${role})`;
  });
  return id;
}

/** Picks a workspace in the switcher (opening its menu unless it is open). */
async function choose(name: string) {
  const menu = page.getByRole('menu');
  if (!(await menu.isVisible())) await page.getByTestId('workspace-switcher').click();
  await menu.getByTestId('workspace-option').filter({ hasText: name }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('workspace-switcher')).toContainText(name);
}

test('team workspaces arrive by sync; new notes go to the active one', async ({ browser }) => {
  test.setTimeout(scaled(180_000));
  const electronApp = await launch();
  await signInDesktop(electronApp, page, browser, email);
  const switcher = page.getByTestId('workspace-switcher');
  await expect(switcher).toContainText('Personal');
  await expect(switcher).toContainText('Personal space');

  const [me] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
  userId = me!.id;
  designId = await joinTeam(DESIGN, 'member');
  boardId = await joinTeam(BOARD, 'viewer');

  // SSE says my workspaces changed → the pull restarts → both teams, with my role, in the switcher.
  await expect
    .poll(
      async () =>
        (await invoke<{ workspaces: { name: string }[] }>(page, 'workspaces:list')).workspaces
          .length,
      { timeout: scaled(20_000) },
    )
    .toBe(3);
  await switcher.click();
  const options = page.getByTestId('workspace-option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText('Personal space');
  await expect(options.filter({ hasText: BOARD })).toContainText('View only');
  await expect(options.filter({ hasText: DESIGN })).toContainText('Member');
  await evidence(page, 'desktop-switcher-open', TASK);

  // Design team: its list is empty; a new meeting note records into it.
  await choose(DESIGN);
  await expect(page.getByTestId('meeting-list-empty')).toHaveText(
    `Meeting notes in ${DESIGN} appear here.`,
  );
  await expect(page.getByTestId('workspace-hint')).toHaveCount(0);
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording', {
    timeout: scaled(20_000),
  });
  await expect(page.getByTestId('note-workspace')).toHaveText(DESIGN);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(1);
  await expect(
    page.getByTestId('transcript-panel').locator('[data-testid=transcript-segment]').first(),
  ).toBeVisible({ timeout: scaled(20_000) });
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
  await evidence(page, 'desktop-team-note', TASK);

  await synced();
  const [row] = await sql<{ workspace_id: string; visibility: string; owner_id: string }[]>`
    select d.workspace_id, d.visibility, d.owner_id
    from meeting m join document d on d.id = m.document_id where m.id = ${meetingId}`;
  expect(row).toEqual({ workspace_id: designId, visibility: 'private', owner_id: userId });
  const [segments] = await sql<{ n: number }[]>`
    select count(*)::int as n from transcript_segment where meeting_id = ${meetingId}`;
  expect(segments!.n).toBeGreaterThan(0);
});

test('as a viewer, new notes go to Personal (and the sidebar says so)', async () => {
  test.setTimeout(scaled(90_000));
  await choose(BOARD);
  await expect(page.getByTestId('workspace-hint')).toHaveText(
    `You can view ${BOARD} but not add notes to it. New notes go to Personal.`,
  );
  await expect(page.getByTestId('meeting-list-empty')).toBeVisible();

  // "Start notes" on an Upcoming event: the note is made in Personal.
  const upcoming = page.getByTestId('upcoming');
  await upcoming.getByTestId('upcoming-event').filter({ hasText: EVENT }).click();
  await expect(page.getByTestId('note-title')).toHaveValue(EVENT);
  await expect(page.getByTestId('note-workspace')).toHaveText('Personal');
  await expect(upcoming.getByTestId('upcoming-event-workspace')).toHaveText('in Personal');
  await evidence(page, 'desktop-viewer-hint', TASK);
  await synced();
  const [doc] = await sql<{ workspace_id: string }[]>`
    select d.workspace_id from meeting m join document d on d.id = m.document_id
    where m.calendar_event_id like ${`ical:planning-${run}@oat.test%`}`;
  expect(doc?.workspace_id).not.toBe(boardId);
  expect(doc?.workspace_id).toBe(
    (
      await sql<{ id: string }[]>`
      select id from workspace where created_by = ${userId} and kind = 'personal'`
    )[0]!.id,
  );

  // Personal lists that note, not the Design team one.
  await choose('Personal');
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(1);
  await expect(page.getByTestId('meeting-list-item')).toContainText(EVENT);
  await expect(upcoming.getByTestId('upcoming-event-workspace')).toHaveCount(0);
});

test('a role change follows by sync; the active workspace survives a relaunch', async () => {
  test.setTimeout(scaled(120_000));
  await choose(DESIGN);
  await sql`update membership set role = 'viewer' where workspace_id = ${designId} and user_id = ${userId}`;
  await expect(page.getByTestId('workspace-switcher')).toContainText('View only', {
    timeout: scaled(20_000),
  });
  await expect(page.getByTestId('workspace-hint')).toBeVisible();
  // Its note is view-only here now.
  await page.getByTestId('meeting-list-item').first().click();
  await expect(page.getByTestId('note-workspace')).toHaveText(DESIGN);
  await expect(page.getByText('View only', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('note-title')).toHaveAttribute('readonly');

  await launch();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await expect(page.getByTestId('workspace-switcher')).toContainText(DESIGN);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(1);
});
