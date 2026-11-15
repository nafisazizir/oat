import { expect, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';

export async function openPlayground(
  page: Page,
  { doc = 'empty', theme = 'light' }: { doc?: 'empty' | 'sample'; theme?: 'light' | 'dark' } = {},
) {
  await page.goto(`/?doc=${doc}&theme=${theme}`);
  const editor = page.getByRole('textbox', { name: 'Note' });
  await expect(editor).toBeVisible();
  await page.waitForFunction(() => window.__oatEditor !== undefined);
  return editor;
}

export function getJSON(page: Page): Promise<JSONContent> {
  return page.evaluate(() => window.__oatEditor!.getJSON());
}

export const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'callout',
]);

export function blocks(doc: JSONContent): JSONContent[] {
  const out: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type && BLOCK_TYPES.has(node.type)) out.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return out;
}
