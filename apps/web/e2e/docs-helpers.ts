import { mkdirSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

import type { DocumentDetail, FolderSummary } from '../src/lib/api-types';
import { EVIDENCE_3_3 } from './paths';

/**
 * Documents/folders test data through the real API, as the signed-in browser user (the page's cookies;
 * writes carry our Origin like the app's own fetches do).
 */

/** Runs a ⌘K palette command by its name — how Tasks, Templates and Trash are reached. */
export async function runCommand(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const input = palette.getByRole('combobox');
  await input.fill(name);
  await expect(palette.getByRole('option', { name, exact: true, selected: true })).toBeVisible();
  await input.press('Enter');
  await expect(palette).toBeHidden();
}

/** The active workspace id (the sidebar carries it). Navigates to /home if no app page is open. */
export async function activeWorkspaceId(page: Page): Promise<string> {
  const sidebar = page.getByTestId('app-sidebar');
  if (!(await sidebar.count())) await page.goto('/home');
  const id = await sidebar.getAttribute('data-workspace-id');
  expect(id, 'data-workspace-id on the sidebar').toBeTruthy();
  return id!;
}

const origin = (page: Page) => new URL(page.url()).origin;

export async function apiCreateDocument(
  page: Page,
  body: {
    title?: string;
    folderId?: string | null;
    kind?: 'page' | 'meeting';
    visibility?: string;
  },
): Promise<DocumentDetail> {
  const workspaceId = await activeWorkspaceId(page);
  const res = await page.request.post('/api/documents', {
    data: { workspaceId, ...body },
    headers: { origin: origin(page) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as DocumentDetail;
}

export async function apiCreateFolder(
  page: Page,
  body: { name: string; parentId?: string | null; visibility?: 'private' | 'workspace' },
): Promise<FolderSummary> {
  const workspaceId = await activeWorkspaceId(page);
  const res = await page.request.post('/api/folders', {
    data: { workspaceId, ...body },
    headers: { origin: origin(page) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as FolderSummary;
}

export async function apiUpdateDocument(
  page: Page,
  id: string,
  body: { baseVersion: number; title?: string; contentJson?: unknown },
) {
  return page.request.patch(`/api/documents/${id}`, {
    data: body,
    headers: { origin: origin(page) },
  });
}

/** A unique suffix so parallel tests sharing a user never collide on titles. */
export const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;

/** Screenshot for docs/tasks/evidence/3.3, only with `E2E_SCREENSHOTS` set (tracked files). */
export async function evidence33(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_3_3, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_3_3}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

/** The sidebar row of a tree item by its visible title. */
export function treeRow(page: Page, title: string) {
  return page.getByTestId('tree-item').filter({ has: page.getByRole('link', { name: title }) });
}

/** Opens a tree row's "…" menu and picks `item`. */
export async function rowAction(page: Page, title: string, item: string) {
  const row = treeRow(page, title);
  await row.hover();
  await row.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Sidebar changes show before the server confirms them: wait until none is pending. */
export async function treeSettled(page: Page) {
  await expect(page.getByTestId('app-sidebar')).not.toHaveAttribute('data-saving');
}
