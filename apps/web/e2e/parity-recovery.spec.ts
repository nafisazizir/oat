import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, unique, treeSettled } from './docs-helpers';
import { expect, test } from './fixtures';

test.use({ storageState: SIGNED_OUT });
test('Home includes pages and meeting notes; document action slots trash, restore and delete', async ({
  page,
  baseURL,
}) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-parity-home'), baseURL!);
  const pageDoc = await apiCreateDocument(page, { title: unique('Home page') });
  const meetingDoc = await apiCreateDocument(page, {
    kind: 'meeting',
    title: unique('Home meeting'),
  });
  await page.goto('/home');
  const rows = page.getByTestId('home-note-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: pageDoc.title })).toHaveCount(1);
  await expect(rows.filter({ hasText: meetingDoc.title })).toHaveCount(1);
  await rows.filter({ hasText: pageDoc.title }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${pageDoc.id}$`));
  await treeSettled(page);
  await page.getByTestId('document-more').click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  const trash = page.getByTestId('trash-banner');
  await expect(trash).toBeVisible();
  await trash.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(trash).toHaveCount(0);
  await treeSettled(page);
  await page.getByTestId('document-more').click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(trash).toBeVisible();
  await trash.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(rows.filter({ hasText: pageDoc.title })).toHaveCount(0);
  await expect(rows.filter({ hasText: meetingDoc.title })).toHaveCount(1);
});
