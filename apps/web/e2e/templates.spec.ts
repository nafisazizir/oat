import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';

/**
 * Task 4.3: templates list, built-in → custom duplicate, editor (rename, reorder by drag and keyboard, add
 * a section, save), persistence, delete. With `E2E_SCREENSHOTS=1` also writes evidence screenshots to
 * docs/tasks/evidence/4.3/ (tracked files, so opt-in).
 */
const EVIDENCE = fileURLToPath(new URL('../../../docs/tasks/evidence/4.3/', import.meta.url));

test.use({ viewport: { width: 1280, height: 860 } });
test.describe.configure({ mode: 'serial' });

/**
 * `tall` grows the viewport for the shot instead of `fullPage` (the app shell's sidebar is fixed, so a
 * stitched full-page capture repeats it mid-page).
 */
async function shoot(page: Page, name: string, options: { tall?: boolean } = {}) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const size = page.viewportSize()!;
  if (options.tall) await page.setViewportSize({ width: size.width, height: 1500 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    style: 'nextjs-portal { display: none !important; } [data-sonner-toaster] { display: none; }',
  });
  if (options.tall) await page.setViewportSize(size);
}

const headings = (page: Page) =>
  page.getByTestId('template-section').getByRole('textbox', { name: /heading$/ });

async function expectOrder(page: Page, order: string[]) {
  await expect(headings(page)).toHaveCount(order.length);
  for (const [i, heading] of order.entries())
    await expect(headings(page).nth(i)).toHaveValue(heading);
}

const row = (page: Page, i: number): Locator => page.getByTestId('template-section').nth(i);

test('create a custom template from a built-in, reorder sections and save', async ({ page }) => {
  await page.goto('/templates');
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  const cards = page.getByTestId('template-card');
  await expect(cards).toHaveCount(5);
  await expect(cards.first()).toContainText('General');
  await expect(page.getByText('No custom templates yet')).toBeVisible();
  await shoot(page, 'list-empty', { tall: true });

  // Built-ins are read-only: view, then duplicate.
  await cards.filter({ hasText: 'General' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  await expect(page.getByText('Built-in templates can’t be edited.')).toBeVisible();
  await shoot(page, 'builtin-detail');
  await page.getByRole('button', { name: 'Duplicate to customize' }).click();

  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('textbox', { name: 'Template name' })).toHaveValue('General (copy)');
  await expectOrder(page, ['Summary', 'Discussion', 'Decisions', 'Action items']);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  // Rename.
  await page.getByRole('textbox', { name: 'Template name' }).fill('Team sync');
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved changes');

  // Duplicating with unsaved edits asks first (the copy is made from the saved version).
  await page.getByRole('button', { name: 'Template actions' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  const confirm = page.getByRole('dialog', { name: 'Duplicate without your changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Template name' })).toHaveValue('Team sync');

  // Drag "Action items" (last) above "Summary" (first).
  await row(page, 3)
    .getByTestId('section-handle')
    .dragTo(row(page, 0), { targetPosition: { x: 40, y: 8 } });
  await expectOrder(page, ['Action items', 'Summary', 'Discussion', 'Decisions']);

  // Keyboard: move "Summary" down one (focus stays on its handle).
  await row(page, 1).getByTestId('section-handle').focus();
  await page.keyboard.press('ArrowDown');
  await expectOrder(page, ['Action items', 'Discussion', 'Summary', 'Decisions']);
  await expect(page.getByRole('button', { name: 'Reorder Summary' })).toBeFocused();

  // Add a section.
  await page.getByRole('button', { name: 'Add section' }).click();
  await expect(headings(page)).toHaveCount(5);
  await expect(headings(page).nth(4)).toBeFocused();
  await headings(page).nth(4).fill('Risks');
  await row(page, 4)
    .getByRole('textbox', { name: /instructions$/ })
    .fill('Anything that could slip, with who is watching it.');

  // Duplicate headings are flagged and block saving.
  await headings(page).nth(4).fill('summary');
  await expect(row(page, 4).getByText('Another section already uses this heading.')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Section headings must be unique.');
  await headings(page).nth(4).fill('Risks');

  await shoot(page, 'editor-sections', { tall: true });
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByTestId('template-preview')).toContainText('Risks');
  await shoot(page, 'editor-preview', { tall: true });
  await page.getByRole('tab', { name: 'Sections' }).click();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Template saved')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  // Persisted.
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Template name' })).toHaveValue('Team sync');
  await expectOrder(page, ['Action items', 'Discussion', 'Summary', 'Decisions', 'Risks']);
  await expect(row(page, 4).getByRole('textbox', { name: /instructions$/ })).toHaveValue(
    'Anything that could slip, with who is watching it.',
  );

  await page.goto('/templates');
  await expect(page.getByTestId('template-card')).toHaveCount(6);
  await expect(page.getByTestId('template-card').last()).toContainText('Team sync');
  await expect(page.getByTestId('template-card').last()).toContainText(
    'Action items · Discussion · Summary · Decisions · Risks',
  );
  await shoot(page, 'list-with-custom', { tall: true });
});

test('start from scratch, then delete', async ({ page }) => {
  await page.goto('/templates');
  await page.getByRole('link', { name: 'New template' }).first().click();
  await expect(page).toHaveURL(/\/templates\/new$/);
  await page.getByRole('textbox', { name: 'Template name' }).fill('Design crit');
  await page.getByRole('textbox', { name: 'Description' }).fill('Feedback on work in progress.');
  await headings(page).first().fill('Feedback');
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('textbox', { name: 'Template name' })).toHaveValue('Design crit');

  await page.getByRole('button', { name: 'Template actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete template' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Delete “Design crit”?' })).toBeVisible();
  await shoot(page, 'delete-dialog');
  await page.getByRole('button', { name: 'Delete template' }).click();
  await page.waitForURL(/\/templates$/);
  await expect(page.getByTestId('template-card').filter({ hasText: 'Design crit' })).toHaveCount(0);
});

test('dark theme editor', async ({ page }) => {
  test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots only');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('oat-theme', 'dark'));
  await page.goto('/templates');
  await page.getByRole('link', { name: /^Team sync/ }).click();
  await expect(page.getByTestId('template-editor')).toBeVisible();
  await shoot(page, 'editor-dark', { tall: true });
  await page.goto('/templates');
  await shoot(page, 'list-dark', { tall: true });
});
