import { readFileSync } from 'node:fs';

import type { Locator, Page } from '@playwright/test';

import type { DocumentDetail, FolderSummary } from '../src/lib/api-types';
import { readZip } from '../src/server/export/read-zip';
import { SIGNED_OUT } from './auth-helpers';
import { expect, test } from './fixtures';
import {
  company,
  openJoining,
  type Person,
  shot,
  signUp,
  type Theme,
  violations,
} from './people-helpers';

/**
 * Private / Shared and leaving (D-36, task unified-workspaces step C), with two real users in one
 * workspace: the sidebar's two sections, a note changing section when its visibility changes (no
 * reload), a teammate never seeing a private item, visibility labels that say what the visibility is,
 * the workspace list hidden with one workspace, and the leave dialog's "Export my notes" — what the zip
 * holds, and that nothing in it can be read after leaving. The sidebar and the leave dialog are scanned
 * with axe in light and dark; `E2E_SCREENSHOTS=1` writes docs/tasks/evidence/unified-workspaces.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

const SIDEBAR = '[data-testid="app-sidebar"]';

const section = (page: Page, area: 'private' | 'shared') =>
  page.getByTestId(`tree-section-${area}`);
const row = (within: Locator, id: string) =>
  within.locator(`[data-testid="tree-item"][data-node-id="${id}"]`);

async function workspaceId(page: Page): Promise<string> {
  const id = await page.getByTestId('app-sidebar').getAttribute('data-workspace-id');
  expect(id).toBeTruthy();
  return id!;
}

const origin = (page: Page) => ({ origin: new URL(page.url()).origin });

async function createDoc(
  page: Page,
  body: { title: string; visibility?: 'private' | 'workspace'; folderId?: string; text?: string },
): Promise<DocumentDetail> {
  const { text, ...rest } = body;
  const res = await page.request.post('/api/documents', {
    data: {
      workspaceId: await workspaceId(page),
      ...rest,
      ...(text
        ? {
            contentJson: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
          }
        : {}),
    },
    headers: origin(page),
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as DocumentDetail;
}

async function createFolder(
  page: Page,
  body: { name: string; visibility: 'private' | 'workspace' },
): Promise<FolderSummary> {
  const res = await page.request.post('/api/folders', {
    data: { workspaceId: await workspaceId(page), ...body },
    headers: origin(page),
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as FolderSummary;
}

/** Opens the Share dialog of the open document and picks a "General access" option. */
async function setAccess(page: Page, option: 'Private' | 'Workspace') {
  await page.getByTestId('share-button').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: new RegExp(`^${option}`) }).click();
  await expect(dialog.getByRole('radio', { name: new RegExp(`^${option}`) })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

/** An owner's workspace that people on its domain join in one click, and one such teammate in it. */
async function team(browser: Parameters<typeof company>[0], theme: Theme) {
  const { owner, domain, name } = await company(browser, theme);
  await openJoining(owner, domain, { testId: 'auto_join', label: 'Join automatically' });
  const mate = await signUp(browser, 'mate', domain, theme);
  await expect(mate.page).toHaveURL(/\/join$/);
  await mate.page.getByRole('button', { name: `Join ${name}` }).click();
  await mate.page.waitForURL(/\/home$/);
  await expect(mate.page.getByTestId('workspace-switcher')).toContainText(name);
  await owner.page.goto('/home');
  return { owner, mate, domain, name };
}

for (const theme of ['light', 'dark'] as const) {
  test(`sidebar (${theme}): Private and Shared; a note moves when its visibility changes; a teammate never sees my private items`, async ({
    browser,
  }) => {
    const { owner, mate, name } = await team(browser, theme);
    const me = owner.page;
    const found: string[] = [];

    // Two quiet sections, Private first, each saying what goes there while it is empty.
    await expect(me.locator(`${SIDEBAR} [data-testid^="tree-section-"]`)).toHaveCount(2);
    await expect(section(me, 'private')).toContainText('Private');
    await expect(section(me, 'shared')).toContainText('Shared');
    await expect(me.getByTestId('tree-empty-private')).toHaveText('Notes only you can see.');
    await expect(me.getByTestId('tree-empty-shared')).toHaveText('Notes everyone here can see.');
    const order = await me
      .locator(`${SIDEBAR} [data-testid^="tree-section-"]`)
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(order).toEqual(['tree-section-private', 'tree-section-shared']);
    found.push(...(await violations(me, `sidebar empty ${theme}`, SIDEBAR)));
    await shot(me, `sidebar-empty-${theme}`);

    // A new note starts in Private.
    await me.getByRole('button', { name: 'New note' }).click();
    await me.waitForURL(/\/d\/[^/]+$/);
    const noteId = me.url().split('/d/')[1]!;
    await expect(row(section(me, 'private'), noteId)).toBeVisible();
    await expect(row(section(me, 'shared'), noteId)).toHaveCount(0);
    await expect(me.getByTestId('visibility-badge')).toHaveText('Private');
    await me.getByTestId('document-title').fill('Roadmap draft');
    await expect(me.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

    // More of mine: a private folder with a page in it, a shared folder, and a private page inside the
    // shared folder (allowed: only its owner sees it).
    const privateFolder = await createFolder(me, { name: 'My drafts', visibility: 'private' });
    const inPrivateFolder = await createDoc(me, {
      title: 'Half an idea',
      folderId: privateFolder.id,
    });
    const sharedFolder = await createFolder(me, { name: 'Projects', visibility: 'workspace' });
    const sharedDoc = await createDoc(me, { title: 'Team handbook', folderId: sharedFolder.id });
    const privateInShared = await createDoc(me, {
      title: 'My notes on Projects',
      folderId: sharedFolder.id,
      visibility: 'private',
    });
    expect(sharedDoc.visibility).toBe('workspace');
    expect(privateInShared.visibility).toBe('private');
    await me.reload();
    for (const id of [noteId, privateFolder.id, inPrivateFolder.id, privateInShared.id]) {
      await expect(row(section(me, 'private'), id), id).toBeVisible();
      await expect(row(section(me, 'shared'), id), id).toHaveCount(0);
    }
    for (const id of [sharedFolder.id, sharedDoc.id]) {
      await expect(row(section(me, 'shared'), id), id).toBeVisible();
      await expect(row(section(me, 'private'), id), id).toHaveCount(0);
    }
    found.push(...(await violations(me, `sidebar ${theme}`, SIDEBAR)));
    await shot(me, `sidebar-private-shared-${theme}`);

    // The teammate sees the shared items and none of my private ones — not in the sidebar…
    const them = mate.page;
    await them.goto('/home');
    for (const id of [sharedFolder.id, sharedDoc.id]) {
      await expect(row(section(them, 'shared'), id), id).toBeVisible();
    }
    await expect(them.getByTestId('tree-empty-private')).toBeVisible();
    for (const id of [noteId, privateFolder.id, inPrivateFolder.id, privateInShared.id]) {
      await expect(row(them.locator(SIDEBAR), id), id).toHaveCount(0);
    }
    await expect(them.locator(SIDEBAR)).not.toContainText('Roadmap draft');
    await expect(them.locator(SIDEBAR)).not.toContainText('My drafts');
    await expect(them.locator(SIDEBAR)).not.toContainText('My notes on Projects');
    // …not inside the shared folder's page, not by address, not through the API.
    await them.goto(`/d/${sharedFolder.id}`);
    await expect(them.getByTestId('folder-contents')).toContainText('Team handbook');
    await expect(them.getByTestId('folder-contents')).not.toContainText('My notes on Projects');
    for (const id of [noteId, inPrivateFolder.id, privateInShared.id]) {
      expect((await them.request.get(`/api/documents/${id}`)).status(), id).toBe(404);
    }
    const listed = (await (
      await them.request.get(`/api/documents?workspaceId=${await workspaceId(them)}`)
    ).json()) as DocumentDetail[];
    expect(listed.map((d) => d.id)).toEqual([sharedDoc.id]);

    // Sharing my note moves it to Shared at once — no reload — and its badge says who it reaches.
    await me.goto(`/d/${noteId}`);
    await expect(me.getByTestId('document-title')).toHaveValue('Roadmap draft');
    await setAccess(me, 'Workspace');
    await expect(row(section(me, 'shared'), noteId)).toBeVisible();
    await expect(row(section(me, 'private'), noteId)).toHaveCount(0);
    await expect(me.getByTestId('visibility-badge')).toHaveText(`Everyone in ${name}`);
    // Now the teammate has it, under Shared.
    await them.goto('/home');
    await expect(row(section(them, 'shared'), noteId)).toBeVisible();
    await expect(row(section(them, 'private'), noteId)).toHaveCount(0);
    expect((await them.request.get(`/api/documents/${noteId}`)).status()).toBe(200);

    // Making it private again moves it back, and takes it away from the teammate.
    await setAccess(me, 'Private');
    await expect(row(section(me, 'private'), noteId)).toBeVisible();
    await expect(row(section(me, 'shared'), noteId)).toHaveCount(0);
    await expect(me.getByTestId('visibility-badge')).toHaveText('Private');
    await them.reload();
    await expect(row(them.locator(SIDEBAR), noteId)).toHaveCount(0);
    expect((await them.request.get(`/api/documents/${noteId}`)).status()).toBe(404);

    expect(found, 'axe violations on the sidebar').toEqual([]);

    // Removed by the owner while the domain still lets people join: the way back is an invitation, so
    // the removed teammate — now in a workspace of their own — is not offered "Join a workspace", and
    // the join screen has nothing for them.
    await me.goto('/settings/workspace/members');
    await me
      .getByTestId('member-row')
      .filter({ visible: true })
      .filter({ hasText: mate.email })
      .getByRole('button', { name: /^Remove / })
      .click();
    const remove = me.getByTestId('remove-member-dialog');
    await remove.getByRole('button', { name: 'Remove' }).click();
    await expect(remove).toBeHidden();
    await expect(me.getByText(/^Removed /)).toBeVisible();
    await them.goto('/home');
    await expect(them.getByTestId('workspace-switcher')).toContainText('My workspace');
    await them.getByTestId('workspace-switcher').click();
    await expect(them.getByRole('menuitem', { name: 'Create workspace' })).toBeVisible();
    await expect(them.getByRole('menuitem', { name: 'Join a workspace' })).toHaveCount(0);
    await them.keyboard.press('Escape');
    await them.goto('/join');
    await expect(them).toHaveURL(/\/home$/);
    expect((await them.request.get(`/api/documents/${sharedDoc.id}`)).status()).toBe(404);

    for (const person of [owner, mate]) await person.context.close();
  });
}

test('labels say what the visibility is: a workspace-visible note in a workspace of one is not "Only you"', async ({
  browser,
}) => {
  // Alone in the workspace made at sign-up.
  const solo = await signUp(browser, 'solo', `solo-${Date.now()}.test`);
  const { page } = solo;
  await expect(page).toHaveURL(/\/home$/);
  const soloWorkspaces = await (await page.request.get('/api/workspaces')).json();
  expect(soloWorkspaces.workspaces).toEqual([expect.objectContaining({ memberCount: 1 })]);

  const shared = await createDoc(page, { title: 'Open to the workspace', visibility: 'workspace' });
  await page.goto(`/d/${shared.id}`);
  await expect(page.getByTestId('visibility-badge')).toHaveText('Everyone in My workspace');
  await expect(page.getByTestId('visibility-badge')).not.toContainText(/only you/i);
  await expect(row(section(page, 'shared'), shared.id)).toBeVisible();
  await page.getByTestId('share-button').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(page.getByTestId('share-summary')).toHaveText(
    'Everyone in My workspace can open this.',
  );
  // The option still says that, so far, that is one person.
  await expect(dialog.getByRole('radio', { name: /^Workspace/ })).toBeChecked();
  await expect(dialog).toContainText('Everyone in My workspace (only you, so far)');
  await dialog.getByRole('radio', { name: /^Private/ }).click();
  await expect(page.getByTestId('share-summary')).toHaveText('Only you can open this.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('visibility-badge')).toHaveText('Private');
  await expect(row(section(page, 'private'), shared.id)).toBeVisible();

  // A shared folder's page says the same.
  const folder = await createFolder(page, { name: 'Shared folder', visibility: 'workspace' });
  await page.goto(`/d/${folder.id}`);
  await expect(page.getByText('Everyone in My workspace', { exact: true })).toBeVisible();
  await solo.context.close();
});

test('the workspace list is absent with one workspace and present with two; creating one stays reachable', async ({
  browser,
}) => {
  const solo = await signUp(browser, 'switch', `switch-${Date.now()}.test`);
  const { page } = solo;
  const menuButton = page.getByTestId('workspace-switcher');

  // One workspace: the button says where I am, without the selector; the menu has no list.
  await expect(menuButton).toContainText('My workspace');
  await expect(menuButton).toHaveAttribute('data-switchable', 'false');
  await menuButton.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('workspace-list')).toHaveCount(0);
  await expect(page.getByTestId('workspace-option')).toHaveCount(0);
  // Workspace management lives in Settings; account actions and creation remain here.
  await expect(menu.getByRole('menuitem', { name: /^Settings/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Invite members' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Leave / })).toHaveCount(0);
  // Nothing is open to this address, so "Join a workspace" isn't offered.
  await expect(menu.getByRole('menuitem', { name: 'Join a workspace' })).toHaveCount(0);
  await shot(page, 'workspace-menu-one-workspace-light');

  await menu.getByRole('menuitem', { name: 'Create workspace' }).click();
  const create = page.getByTestId('create-workspace-dialog');
  await create.getByLabel('Name').fill('Second home');
  await create.getByRole('button', { name: 'Create workspace' }).click();
  await expect(create).toBeHidden();

  // Two: the list is there (switching itself is covered by auth.spec).
  await expect(menuButton).toContainText('Second home');
  await expect(menuButton).toHaveAttribute('data-switchable', 'true');
  await menuButton.click();
  await expect(page.getByTestId('workspace-list')).toBeVisible();
  await expect(page.getByTestId('workspace-option')).toHaveCount(2);
  await shot(page, 'workspace-menu-two-workspaces-light');
  await page.keyboard.press('Escape');

  // Back to one (delete the second, which is the active one): the list goes away again.
  await page.goto('/settings/workspace');
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  const del = page.getByTestId('delete-workspace-dialog');
  await del.getByLabel(/to confirm/).fill('Second home');
  await del.getByRole('button', { name: 'Delete workspace' }).click();
  await page.waitForURL(/\/home$/, { waitUntil: 'load' });
  await expect(menuButton).toContainText('My workspace');
  await expect(menuButton).toHaveAttribute('data-switchable', 'false');
  await menuButton.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByTestId('workspace-list')).toHaveCount(0);
  await solo.context.close();
});

/** The member's second workspace: someone with a workspace of their own joins the company's from the menu. */
async function joinFromMenu(person: Person, name: string) {
  const { page } = person;
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Join a workspace' }).click();
  await page.waitForURL(/\/join$/);
  // They have a workspace already: the way back, not "Create my own workspace".
  await expect(page.getByRole('link', { name: 'Back to Oat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create my own workspace' })).toHaveCount(0);
  await page.getByRole('button', { name: `Join ${name}` }).click();
  await page.waitForURL(/\/home$/);
  await expect(page.getByTestId('workspace-switcher')).toContainText(name);
}

for (const theme of ['light', 'dark'] as const) {
  test(`leaving (${theme}): the dialog explains, exports only my notes, and after leaving none of them can be read`, async ({
    browser,
  }) => {
    const { owner, domain, name } = await company(browser, theme);
    await openJoining(owner, domain, { testId: 'auto_join', label: 'Join automatically' });
    // The leaver has a workspace of their own first (the last workspace can't be left), then joins.
    const leaver = await signUp(browser, 'leaver', domain, theme);
    await expect(leaver.page).toHaveURL(/\/join$/);
    await leaver.page.getByRole('button', { name: 'Create my own workspace' }).click();
    await leaver.page.waitForURL(/\/home$/);
    await joinFromMenu(leaver, name);
    const { page } = leaver;
    const teamId = await workspaceId(page);

    // Mine in the company workspace: private, shared, one in the trash. And the owner's.
    const mine = {
      private: await createDoc(page, { title: 'My private plan', text: 'Only I know this.' }),
      shared: await createDoc(page, {
        title: 'Handover notes',
        visibility: 'workspace',
        text: 'For the team.',
      }),
      hostile: await createDoc(page, { title: '../../etc/passwd', text: 'A title is only text.' }),
    };
    const binned = await createDoc(page, { title: 'Thrown away', text: 'In the trash.' });
    expect(
      (
        await page.request.delete(`/api/documents/${binned.id}`, { headers: origin(page) })
      ).status(),
    ).toBe(200);
    await owner.page.goto('/home');
    await createDoc(owner.page, { title: 'Owner secret', text: 'The owner’s private note.' });
    await createDoc(owner.page, {
      title: 'Owner shared',
      visibility: 'workspace',
      text: 'The owner’s shared note.',
    });
    await page.reload();

    // The leave dialog says what leaving costs and offers the export.
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await page.getByRole('link', { name: 'General', exact: true }).click();
    await page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
    const dialog = page.getByTestId('leave-workspace-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Leave ${name}?`);
    await expect(dialog).toContainText('including your private notes');
    await expect(dialog).toContainText('nobody else can read them');
    await expect(dialog).toContainText('you won’t be able to open them again');
    const exportLink = dialog.getByRole('button', { name: 'Export my notes' });
    await expect(exportLink).toBeVisible();
    const found = await violations(
      page,
      `leave dialog ${theme}`,
      '[data-testid="leave-workspace-dialog"]',
    );
    await shot(page, `leave-dialog-export-${theme}`);

    // A failed export says so, and never claims a download.
    const exportUrl = `**/api/workspaces/${teamId}/export`;
    await page.route(exportUrl, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{}}' }),
    );
    await exportLink.click();
    await expect(dialog.getByTestId('export-error')).toHaveText(
      'Couldn’t export your notes. Nothing was downloaded — try again.',
    );
    await expect(dialog).not.toContainText('to your downloads');
    found.push(
      ...(await violations(
        page,
        `leave dialog export failed ${theme}`,
        '[data-testid="leave-workspace-dialog"]',
      )),
    );
    await page.unroute(exportUrl);

    const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
    expect(download.suggestedFilename()).toMatch(
      /^oat-notes-acme-[0-9a-f]+-\d{4}-\d{2}-\d{2}\.zip$/,
    );
    await expect(dialog.getByRole('status')).toHaveText(
      'Saved 3 notes to a ZIP file. Check the file before you leave.',
    );
    await expect(dialog.getByTestId('export-error')).toHaveCount(0);
    const files = readZip(readFileSync(await download.path()));
    // Exactly my three live notes, as Markdown, under safe names.
    expect(files.map((f) => f.name).toSorted()).toEqual([
      'Handover notes.md',
      'My private plan.md',
      'etc passwd.md',
    ]);
    const text = new Map(files.map((f) => [f.name, f.text]));
    expect(text.get('My private plan.md')).toBe('# My private plan\n\nOnly I know this.\n');
    expect(text.get('Handover notes.md')).toBe('# Handover notes\n\nFor the team.\n');
    expect(text.get('etc passwd.md')).toBe('# ../../etc/passwd\n\nA title is only text.\n');
    const everything = files.map((f) => `${f.name}\n${f.text}`).join('\n');
    for (const leaked of [
      'Owner secret',
      'Owner shared',
      'owner’s',
      'Thrown away',
      'In the trash',
    ]) {
      expect(everything, leaked).not.toContain(leaked);
    }
    found.push(
      ...(await violations(
        page,
        `leave dialog exported ${theme}`,
        '[data-testid="leave-workspace-dialog"]',
      )),
    );

    // Leave: back in my own workspace, and nothing of the company's is readable any more.
    await dialog.getByRole('button', { name: 'Leave workspace' }).click();
    await page.waitForURL(/\/home$/, { waitUntil: 'load' });
    await expect(page.getByTestId('workspace-switcher')).toContainText('My workspace');
    await expect(page.getByTestId('workspace-switcher')).toHaveAttribute(
      'data-switchable',
      'false',
    );
    for (const note of [...Object.values(mine), binned]) {
      expect((await page.request.get(`/api/documents/${note.id}`)).status(), note.title).toBe(404);
    }
    expect((await page.request.get(`/api/documents?workspaceId=${teamId}`)).status()).toBe(404);
    expect((await page.request.get(`/api/workspaces/${teamId}/export`)).status()).toBe(404);
    await page.goto(`/d/${mine.private.id}`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('My private plan');

    // The notes stayed behind: the shared one is the team's; the private one nobody else can open.
    await owner.page.goto('/home');
    await expect(row(section(owner.page, 'shared'), mine.shared.id)).toBeVisible();
    expect((await owner.page.request.get(`/api/documents/${mine.private.id}`)).status()).toBe(404);

    expect(found, 'axe violations on the leave dialog').toEqual([]);
    for (const person of [owner, leaver]) await person.context.close();
  });
}
