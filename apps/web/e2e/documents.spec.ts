import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import {
  apiCreateDocument,
  apiCreateFolder,
  apiUpdateDocument,
  evidence33,
  rowAction,
  treeRow,
  treeSettled,
} from './docs-helpers';
import { expect, test } from './fixtures';
import { STORAGE_STATE } from './paths';

/**
 * Task 3.3 in the browser: real documents and folders through the API, the sidebar tree and the
 * document page. Each test signs up its own user, so trees and "Recent notes" never collide with
 * other specs running in parallel.
 */
test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-docs'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

test('creates a page, writes with the slash menu, and it persists across a reload', async ({
  page,
}) => {
  await evidence33(page, 'home-empty');
  await page.getByRole('button', { name: 'Add to Private' }).click();
  await page.getByRole('menuitem', { name: 'New page' }).click();
  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}$/);
  const docUrl = page.url();

  // A new page opens with the title focused.
  const title = page.getByTestId('document-title');
  await expect(title).toBeFocused();
  await page.keyboard.type('Launch plan');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();

  await page.keyboard.type('/head');
  const menu = page.getByRole('listbox', { name: 'Insert block' });
  await expect(menu).toBeVisible();
  await evidence33(page, 'editor-slash-menu');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Goals');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ship the documents API.');
  await saved(page);
  await expect(treeRow(page, 'Launch plan')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Launch plan');
  await evidence33(page, 'editor-saved');

  await page.reload();
  await expect(page.getByTestId('document-title')).toHaveValue('Launch plan');
  await expect(editor(page).locator('h1')).toHaveText('Goals');
  await expect(editor(page).getByText('Ship the documents API.')).toBeVisible();
  expect(page.url()).toBe(docUrl);

  // "New note" makes a meeting note, which Home lists under Recent notes.
  await page.getByRole('button', { name: 'New note' }).first().click();
  await expect(page).not.toHaveURL(docUrl);
  await page.keyboard.type('Standup');
  await saved(page);
  await page.goto('/home');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /Standup/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Launch plan/ })).toBeVisible();
  await evidence33(page, 'home-with-notes');
});

test('folders: create + rename inline, move a shared page into a private folder (confirm), trash + restore', async ({
  page,
}) => {
  // A team workspace, so there is a Shared section.
  const switcher = page.getByTestId('workspace-switcher');
  await switcher.click();
  await page.getByRole('menuitem', { name: 'Create workspace' }).click();
  await page.getByTestId('create-workspace-dialog').getByLabel('Name').fill('Docs Team');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(switcher).toContainText('Docs Team');

  // Shared page.
  await page.getByRole('button', { name: 'Add to Shared' }).click();
  await page.getByRole('menuitem', { name: 'New page' }).click();
  await expect(page.getByTestId('document-title')).toBeFocused();
  await page.keyboard.type('Roadmap');
  await saved(page);
  await expect(
    page.getByTestId('shared-tree').getByRole('link', { name: 'Roadmap' }),
  ).toBeVisible();

  // Private folder, named inline.
  await page.getByRole('button', { name: 'Add to Private' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const rename = page.getByRole('textbox', { name: /^Rename/ });
  await expect(rename).toBeFocused();
  await rename.fill('Drafts');
  await rename.press('Enter');
  await expect(page.getByTestId('page-tree').getByRole('link', { name: 'Drafts' })).toBeVisible();

  // Move to… → Drafts: the page would become private, so the app asks first.
  await rowAction(page, 'Roadmap', 'Move to…');
  const picker = page.getByTestId('move-dialog');
  await expect(picker).toBeVisible();
  await evidence33(page, 'move-dialog');
  await picker.getByRole('option', { name: /Drafts/ }).click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Make “Roadmap” private?');
  await evidence33(page, 'move-confirm-private');
  await confirm.getByRole('button', { name: 'Move and make private' }).click();
  await expect(confirm).toBeHidden();

  const privateTree = page.getByTestId('page-tree');
  await expect(privateTree.getByRole('link', { name: 'Roadmap' })).toBeVisible();
  await expect(page.getByTestId('shared-tree').getByRole('link', { name: 'Roadmap' })).toBeHidden();
  await treeSettled(page);
  await page.reload();
  await expect(page.getByText('Private', { exact: true }).first()).toBeVisible();
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('listitem')).toHaveText([
    'Docs Team',
    'Private',
    'Drafts',
    'Roadmap',
  ]);
  await evidence33(page, 'tree-after-move');

  // Trash, from the sidebar menu: the open page shows the trash banner, read-only.
  await rowAction(page, 'Roadmap', 'Move to trash');
  await expect(page.getByTestId('trash-banner')).toBeVisible();
  await expect(page.getByTestId('document-title')).toHaveAttribute('readonly', '');
  await expect(privateTree.getByRole('link', { name: 'Roadmap' })).toBeHidden();
  await evidence33(page, 'trashed-page');

  // Restore from the trash dialog: back in its folder.
  await page.getByTestId('open-trash').click();
  const trash = page.getByTestId('trash-dialog');
  await expect(trash.getByTestId('trash-item')).toHaveCount(1);
  await evidence33(page, 'trash-dialog');
  await trash.getByRole('button', { name: 'Restore' }).click();
  await expect(trash.getByTestId('trash-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(privateTree.getByRole('link', { name: 'Roadmap' })).toBeVisible();
  await expect(page.getByTestId('trash-banner')).toBeHidden();

  // Trash again and delete forever.
  await rowAction(page, 'Roadmap', 'Move to trash');
  await page.getByTestId('open-trash').click();
  await trash.getByRole('button', { name: 'Delete Roadmap forever' }).click();
  await trash.getByRole('button', { name: 'Delete forever' }).click();
  await expect(trash.getByTestId('trash-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/home$/);
});

test('drag a page onto a folder; delete the folder (its pages go to the trash)', async ({
  page,
}) => {
  const folder = await apiCreateFolder(page, { name: 'Archive' });
  await apiCreateDocument(page, { title: 'Old notes' });
  await page.goto('/home');
  const tree = page.getByTestId('page-tree');
  await treeRow(page, 'Old notes').dragTo(treeRow(page, 'Archive'));
  await expect(treeRow(page, 'Old notes')).toHaveAttribute('data-node-id', /.+/);
  // Nested: the folder now has an expand toggle and the page sits under it.
  await expect(tree.getByRole('button', { name: 'Collapse Archive' })).toBeVisible();
  await treeSettled(page);
  await page.goto(`/d/${folder.id}`);
  await expect(page.getByRole('main').getByTestId('folder-contents')).toContainText('Old notes');
  await evidence33(page, 'folder-page');

  await rowAction(page, 'Archive', 'Delete folder');
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Delete “Archive”?');
  await confirm.getByRole('button', { name: 'Delete folder' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(tree.getByRole('link', { name: 'Archive' })).toBeHidden();
  await expect(page.getByTestId('open-trash')).toContainText('1');
});

test('edit the body, then rename from the sidebar: no false conflict, the editor keeps saving', async ({
  page,
}) => {
  // The console guard also proves no request failed (a 409 would be logged as a failed load).
  const doc = await apiCreateDocument(page, { title: 'Body first' });
  await page.goto(`/d/${doc.id}`);
  await editor(page).click();
  await page.keyboard.type('First line');
  await saved(page);

  await rowAction(page, 'Body first', 'Rename');
  const rename = page.getByRole('textbox', { name: /^Rename/ });
  await expect(rename).toBeFocused();
  await rename.fill('Renamed in sidebar');
  await rename.press('Enter');
  await expect(treeRow(page, 'Renamed in sidebar')).toBeVisible();
  // The open editor picks up the new title and version…
  await expect(page.getByTestId('document-title')).toHaveValue('Renamed in sidebar');

  // …and keeps saving on top of it.
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await saved(page);
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');

  await page.reload();
  await expect(page.getByTestId('document-title')).toHaveValue('Renamed in sidebar');
  await expect(editor(page).getByText('First line and more')).toBeVisible();
});

test.describe('conflicts', () => {
  // The 409 itself is logged by the browser as a failed resource load.
  test.use({ allowConsoleErrors: true });

  test('a sidebar rename after a body edit elsewhere re-sends on the new version', async ({
    page,
  }) => {
    const doc = await apiCreateDocument(page, { title: 'Edited elsewhere' });
    await page.goto('/home');
    // Another tab/device edits the body: version 0 → 1; this tab's tree still says 0.
    const res = await page.request.patch(`/api/documents/${doc.id}`, {
      data: {
        baseVersion: 0,
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From elsewhere' }] }],
        },
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(res.status()).toBe(200);

    await rowAction(page, 'Edited elsewhere', 'Rename');
    const rename = page.getByRole('textbox', { name: /^Rename/ });
    await rename.fill('Renamed anyway');
    await rename.press('Enter');
    await expect(treeRow(page, 'Renamed anyway')).toBeVisible();
    await treeSettled(page);
    await expect(page.getByText('This page was renamed elsewhere')).toHaveCount(0);
    await page.goto(`/d/${doc.id}`);
    await expect(page.getByTestId('document-title')).toHaveValue('Renamed anyway');
    await expect(editor(page).getByText('From elsewhere')).toBeVisible();
  });

  test('an edit on a stale version shows the “changed elsewhere” state', async ({ page }) => {
    const doc = await apiCreateDocument(page, { title: 'Shared draft' });
    await page.goto(`/d/${doc.id}`);
    await expect(page.getByTestId('document-title')).toHaveValue('Shared draft');
    // Someone else edits the body first (another tab/device): version 0 → 1.
    const res = await apiUpdateDocument(page, doc.id, {
      baseVersion: 0,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Their edit' }] }],
      },
    });
    expect(res.status()).toBe(200);

    await editor(page).click();
    await page.keyboard.type('My edit');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict');
    await expect(page.getByText('This note changed elsewhere')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload' }).first()).toBeVisible();
    await evidence33(page, 'conflict');
    // Choosing Reload drops the local edits without an "unsaved changes" prompt, and shows theirs.
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type());
      void dialog.accept();
    });
    await page.getByTestId('save-status').getByRole('button', { name: 'Reload' }).click();
    await expect(editor(page).getByText('Their edit')).toBeVisible();
    await expect(editor(page).getByText('My edit')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});

test('another user’s private page is a plain 404', async ({ page, browser, baseURL }) => {
  const doc = await apiCreateDocument(page, { title: 'Only mine' });
  const other = await browser.newContext({ storageState: STORAGE_STATE, baseURL });
  try {
    const otherPage = await other.newPage();
    // (The status is 200: the shell has streamed by the time the page calls notFound().)
    await otherPage.goto(`/d/${doc.id}`);
    await expect(otherPage.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(otherPage.getByText('Only mine')).toHaveCount(0);
    // And through the API.
    const api = await otherPage.request.get(`/api/documents/${doc.id}`);
    expect(api.status()).toBe(404);
  } finally {
    await other.close();
  }
});
