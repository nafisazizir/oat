/**
 * Task 3.9 e2e: the desktop's workspace switcher, against `next dev` on the throwaway database. Fixtures only:
 * audio from FileSource, calendar events from a JSON file (never EventKit), no meeting detection.
 *
 * 1. Signed in (in the workspace made for me at sign-up, "My workspace"), I'm added to two more workspaces
 *    (straight into Postgres, as the web's invite flow would): "Design team" as a member and "Board" as a
 *    viewer. Sync brings them (with my role) to the switcher.
 * 2. Switching to Design team filters the meeting list; "New meeting note" records into Design team (the
 *    header says so) and, synced, the server has the note there — private, mine.
 * 3. Board (viewer): the sidebar says new notes go to the first workspace I can add notes to (Design team);
 *    "Start notes" on an Upcoming event makes the note there, and Upcoming says where it is.
 * 4. Demoted to viewer in Design team: the switcher follows (sync re-sends the workspace with my role) and its
 *    note becomes view-only here. The active workspace survives a relaunch (per account, local database).
 * 5. View-only everywhere (D-36: there is no workspace of last resort any more): the sidebar asks me to
 *    create a workspace, and "New meeting note" is refused with that message before anything is recorded.
 *
 * Step C of unified-workspaces (D-36), woven in: with one workspace the menu has no workspace list; the
 * sidebar splits the notes into Private and Shared — a new recording and a note started from a calendar
 * event land in Private, a teammate's shared note shows under Shared, their private one never arrives, and
 * a note changes section when its visibility changes on the server, without a relaunch. The sidebar is
 * scanned with axe in light and dark (`E2E_SCREENSHOTS=1` writes docs/tasks/evidence/unified-workspaces).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
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
/** The workspace made for a user who signs up without a name (magic link). */
const OWN = 'My workspace';
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

/** Another workspace with me in it at `role` (what accepting an invite does). */
async function joinTeam(name: string, role: 'member' | 'viewer'): Promise<string> {
  const id = `ws-${run}-${role}`;
  await sql.begin(async (tx) => {
    await tx`insert into workspace (id, name, slug, created_by)
             values (${id}, ${name}, ${id}, ${userId})`;
    await tx`insert into membership (id, workspace_id, user_id, role)
             values (${`m-${id}`}, ${id}, ${userId}, ${role})`;
  });
  return id;
}

const inSection = (section: 'private' | 'shared') =>
  page.getByTestId(`meeting-section-${section}`).getByTestId('meeting-list-item');

/** Every axe violation (any impact) inside the sidebar, as short lines. */
async function sidebarViolations(label: string): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  // Legacy mode: axe runs in the page itself (no extra blank page, which Electron can't open).
  const { violations } = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .include('[data-slot="sidebar"]')
    .analyze();
  return violations.flatMap((v) =>
    v.nodes.map((n) => `${label}: ${v.id} (${v.impact}) ${n.target.join(' ')}`),
  );
}

/** Picks a workspace in the switcher (opening its menu unless it is open). */
async function choose(name: string) {
  const menu = page.getByRole('menu');
  if (!(await menu.isVisible())) await page.getByTestId('workspace-switcher').click();
  await menu.getByTestId('workspace-option').filter({ hasText: name }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('workspace-switcher')).toContainText(name);
}

test('workspaces arrive by sync; new notes go to the active one', async ({ browser }) => {
  test.setTimeout(scaled(180_000));
  const electronApp = await launch();
  await signInDesktop(electronApp, page, browser, email);
  const switcher = page.getByTestId('workspace-switcher');
  // The workspace made at sign-up is an ordinary one: its name, and my role in it.
  await expect(switcher).toContainText(OWN);
  await expect(switcher).toContainText('Owner');
  // One workspace: nothing to switch between, so the menu has no workspace list (D-36).
  await expect(switcher).toHaveAttribute('data-switchable', 'false');
  await switcher.click();
  await expect(page.getByRole('menu')).toContainText('Workspace settings (web)');
  await expect(page.getByTestId('workspace-list')).toHaveCount(0);
  await expect(page.getByTestId('workspace-option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  const [me] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
  userId = me!.id;
  designId = await joinTeam(DESIGN, 'member');
  boardId = await joinTeam(BOARD, 'viewer');

  // SSE says my workspaces changed → the pull restarts → both of them, with my role, in the switcher.
  await expect
    .poll(
      async () =>
        (await invoke<{ workspaces: { name: string }[] }>(page, 'workspaces:list')).workspaces
          .length,
      { timeout: scaled(20_000) },
    )
    .toBe(3);
  await expect(switcher).toHaveAttribute('data-switchable', 'true');
  await switcher.click();
  const options = page.getByTestId('workspace-option');
  await expect(options).toHaveCount(3);
  await expect(options.filter({ hasText: OWN })).toContainText('Owner');
  await expect(options.filter({ hasText: BOARD })).toContainText('View only');
  await expect(options.filter({ hasText: DESIGN })).toContainText('Member');
  await evidence(page, 'desktop-switcher-open', TASK);

  // Design team: its list is empty; a new meeting note records into it.
  await choose(DESIGN);
  await expect(page.getByTestId('meeting-list-empty')).toBeVisible();
  // Two sections, each saying what goes there.
  await expect(page.getByTestId('meeting-section-empty-private')).toHaveText(
    'Notes only you can see.',
  );
  await expect(page.getByTestId('meeting-section-empty-shared')).toHaveText(
    'Notes everyone here can see.',
  );
  await expect(page.getByTestId('workspace-hint')).toHaveCount(0);
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording', {
    timeout: scaled(20_000),
  });
  await expect(page.getByTestId('note-workspace')).toHaveText(DESIGN);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(1);
  // A new recording starts in Private.
  await expect(inSection('private')).toHaveCount(1);
  await expect(inSection('shared')).toHaveCount(0);
  // The transcript sits behind its toggle (ui-calm): the toggle counts the lines as they arrive.
  await expect(page.getByRole('button', { name: /^Transcript [1-9]/ })).toBeVisible({
    timeout: scaled(20_000),
  });
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

test('Private and Shared: a teammate’s shared note is under Shared, their private one never arrives, and a note moves when its visibility changes', async () => {
  test.setTimeout(scaled(120_000));
  const mine = inSection('private');
  const shared = inSection('shared');
  await expect(mine).toHaveCount(1);
  const myNote = (await mine.first().getAttribute('data-document-id'))!;

  // A teammate in Design team with a shared and a private meeting note (as written by their own Oat).
  const mate = `mate-${run}`;
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, name, email, email_verified)
             values (${mate}, 'Teammate', ${`mate-${run}@example.test`}, true)`;
    await tx`insert into membership (id, workspace_id, user_id, role)
             values (${`m-${mate}`}, ${designId}, ${mate}, 'member')`;
    await tx`insert into document (id, workspace_id, owner_id, kind, title, visibility)
             values (${`d-${run}-shared`}, ${designId}, ${mate}, 'meeting', 'Teammate standup', 'workspace'),
                    (${`d-${run}-secret`}, ${designId}, ${mate}, 'meeting', 'Teammate secret', 'private')`;
  });
  // Sync brings the shared one — under Shared — and never the private one.
  await expect(shared.filter({ hasText: 'Teammate standup' })).toHaveCount(1, {
    timeout: scaled(20_000),
  });
  await expect(mine).toHaveCount(1);
  await synced();
  await expect(page.getByTestId('meeting-list')).not.toContainText('Teammate secret');
  const local = await invoke<{ notes: { documentId: string; title: string }[] }>(
    page,
    'meetings:list',
  );
  expect(local.notes.map((n) => n.title)).not.toContain('Teammate secret');

  // The sidebar, light and dark: axe clean; evidence at 1440×900.
  const found: string[] = [];
  await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
  );
  await page.mouse.move(700, 450);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.waitForTimeout(400);
    found.push(...(await sidebarViolations(`sidebar ${scheme}`)));
    await evidence(page, `desktop-sidebar-private-shared-${scheme}`, 'unified-workspaces');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  expect(found, 'axe violations in the desktop sidebar').toEqual([]);

  // My note is shared on the web: it moves to Shared here, without a relaunch, and its badge says so.
  await sql`update document set visibility = 'workspace', version = version + 1 where id = ${myNote}`;
  await expect(shared.and(page.locator(`[data-document-id="${myNote}"]`))).toHaveCount(1, {
    timeout: scaled(20_000),
  });
  await expect(mine).toHaveCount(0);
  await expect(page.getByTestId('meeting-section-empty-private')).toBeVisible();
  await shared.and(page.locator(`[data-document-id="${myNote}"]`)).click();
  await expect(page.getByText(`Everyone in ${DESIGN}`, { exact: true })).toBeVisible();
  // …and back when it is made private again.
  await sql`update document set visibility = 'private', version = version + 1 where id = ${myNote}`;
  await expect(mine.and(page.locator(`[data-document-id="${myNote}"]`))).toHaveCount(1, {
    timeout: scaled(20_000),
  });
  await expect(page.getByText('Private', { exact: true }).last()).toBeVisible();

  // The teammate's notes go to the trash: the rest of this file counts my notes only.
  await sql`update document set deleted_at = now(), version = version + 1 where owner_id = ${mate}`;
  await expect(shared).toHaveCount(0, { timeout: scaled(20_000) });
  await synced();
});

test('as a viewer, new notes go to the first workspace I can add to (and the sidebar says so)', async () => {
  test.setTimeout(scaled(90_000));
  await choose(BOARD);
  await expect(page.getByTestId('workspace-hint')).toHaveText(
    `You can view ${BOARD} but not add notes to it. New notes go to ${DESIGN}.`,
  );
  await expect(page.getByTestId('meeting-list-empty')).toBeVisible();

  // "Start notes" on an Upcoming event: the note is made in Design team.
  // Upcoming lives on Home (ui-calm).
  const home = () => page.getByTestId('home-nav').click();
  const upcoming = page.getByTestId('upcoming');
  await home();
  await upcoming.getByTestId('upcoming-event').filter({ hasText: EVENT }).click();
  await expect(page.getByTestId('note-title')).toHaveValue(EVENT);
  await expect(page.getByTestId('note-workspace')).toHaveText(DESIGN);
  await home();
  await expect(upcoming.getByTestId('upcoming-event-workspace')).toHaveText(`in ${DESIGN}`);
  await evidence(page, 'desktop-viewer-hint', TASK);
  await synced();
  const [doc] = await sql<{ workspace_id: string }[]>`
    select d.workspace_id from meeting m join document d on d.id = m.document_id
    where m.calendar_event_id like ${`ical:planning-${run}@oat.test%`}`;
  expect(doc?.workspace_id).not.toBe(boardId);
  expect(doc?.workspace_id).toBe(designId);

  // Design team lists that note next to the recorded one; my own workspace has neither.
  await choose(DESIGN);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(2);
  // Both are mine and private — a note started from a calendar event starts in Private too.
  await expect(inSection('private')).toHaveCount(2);
  await expect(inSection('shared')).toHaveCount(0);
  await expect(page.getByTestId('meeting-list-item').filter({ hasText: EVENT })).toHaveCount(1);
  await home();
  await expect(upcoming.getByTestId('upcoming-event')).not.toHaveCount(0);
  await expect(upcoming.getByTestId('upcoming-event-workspace')).toHaveCount(0);
  await choose(OWN);
  await expect(page.getByTestId('meeting-list-empty')).toBeVisible();
  await expect(page.getByTestId('workspace-hint')).toHaveCount(0);
});

test('a role change follows by sync; the active workspace survives a relaunch', async () => {
  test.setTimeout(scaled(120_000));
  await choose(DESIGN);
  await sql`update membership set role = 'viewer' where workspace_id = ${designId} and user_id = ${userId}`;
  await expect(page.getByTestId('workspace-switcher')).toContainText('View only', {
    timeout: scaled(20_000),
  });
  // The one workspace left where I can add notes is my own.
  await expect(page.getByTestId('workspace-hint')).toHaveText(
    `You can view ${DESIGN} but not add notes to it. New notes go to ${OWN}.`,
  );
  // Its note is view-only here now.
  await page.getByTestId('meeting-list-item').first().click();
  await expect(page.getByTestId('note-workspace')).toHaveText(DESIGN);
  await expect(page.getByText('View only', { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId('note-title')).toHaveAttribute('readonly');

  await launch();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  await expect(page.getByTestId('workspace-switcher')).toContainText(DESIGN);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(2);
});

// D-36: with no workspace I can create in, I'm asked to create one — and nothing is recorded into nowhere.
test('view-only everywhere: the sidebar asks for a workspace and a recording is refused, not lost', async () => {
  test.setTimeout(scaled(90_000));
  await synced();
  const meetings = async () =>
    (
      await sql<{ n: number }[]>`
      select count(*)::int as n from meeting m join document d on d.id = m.document_id
      where d.owner_id = ${userId}`
    )[0]!.n;
  const before = await meetings();
  // My own workspace becomes view-only for me too (as if its other owner had demoted me).
  await sql`update membership set role = 'viewer' where user_id = ${userId}`;
  await expect(page.getByTestId('workspace-hint')).toHaveText(
    `You can view ${DESIGN} but not add notes to it. Create a workspace of your own on the web to take notes.`,
    { timeout: scaled(20_000) },
  );

  await page.getByTestId('new-meeting').click();
  await expect(
    page.getByText(/Create a workspace of your own in Oat on the web, then try again\./).first(),
  ).toBeVisible({ timeout: scaled(20_000) });
  expect((await invoke<{ status: string }>(page, 'recording:get')).status).toBe('idle');
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(2);
  await evidence(page, 'desktop-create-workspace-hint', 'unified-workspaces');
  await synced();
  expect(await meetings()).toBe(before);

  // With a workspace I can create in again, recording works at once and lands there.
  await sql`update membership set role = 'owner'
            where user_id = ${userId} and workspace_id not in (${designId}, ${boardId})`;
  await expect(page.getByTestId('workspace-hint')).toHaveText(
    `You can view ${DESIGN} but not add notes to it. New notes go to ${OWN}.`,
    { timeout: scaled(20_000) },
  );
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording', {
    timeout: scaled(20_000),
  });
  await expect(page.getByTestId('note-workspace')).toHaveText(OWN);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
  await synced();
  expect(await meetings()).toBe(before + 1);
});
