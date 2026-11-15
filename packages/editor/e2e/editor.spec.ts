import { expect, test } from '@playwright/test';

import { blocks, getJSON, openPlayground } from './helpers.ts';

test('Markdown shortcuts create every block and mark', async ({ page }) => {
  const editor = await openPlayground(page);
  const kb = page.keyboard;

  await kb.type('# Heading one');
  await kb.press('Enter');
  await kb.type('## Heading two');
  await kb.press('Enter');
  await kb.type('### Heading three');
  await kb.press('Enter');
  await kb.type('- bullet');
  await kb.press('Enter');
  await kb.press('Enter'); // empty item → leaves the list
  await kb.type('1. numbered');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('[] task');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('> quote');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.type('``` ');
  await kb.type('const a = 1;');
  await kb.press('Enter');
  await kb.press('Enter');
  await kb.press('Enter'); // triple Enter leaves the code block
  await kb.type('---');
  await kb.type('**bold** *italic* ~~strike~~ `code` ==marked== https://oat.app ');
  await kb.press('Shift+Enter');
  await kb.type('after break');

  await expect(editor.locator('h1')).toHaveText('Heading one');
  await expect(editor.locator('h2')).toHaveText('Heading two');
  await expect(editor.locator('h3')).toHaveText('Heading three');
  await expect(editor.locator('ul:not([data-type]) > li')).toHaveText('bullet');
  await expect(editor.locator('ol > li')).toHaveText('numbered');
  await expect(editor.locator('ul[data-type="taskList"] > li .oat-task-content')).toHaveText(
    'task',
  );
  await expect(editor.locator('ul[data-type="taskList"] input[type="checkbox"]')).toHaveCount(1);
  await expect(editor.locator('blockquote')).toHaveText('quote');
  await expect(editor.locator('pre code')).toHaveText('const a = 1;');
  await expect(editor.locator('hr')).toHaveCount(1);
  await expect(editor.locator('strong')).toHaveText('bold');
  await expect(editor.locator('em')).toHaveText('italic');
  await expect(editor.locator('s')).toHaveText('strike');
  await expect(editor.locator('p code')).toHaveText('code');
  await expect(editor.locator('mark')).toHaveText('marked');
  await expect(editor.locator('a[href="https://oat.app"]')).toHaveText('https://oat.app');
  await expect(editor.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);

  const doc = await getJSON(page);
  // Ignore empty paragraphs (the divider rule / trailing-node keep one after the last block).
  const filled = doc.content!.filter((node) => node.type !== 'paragraph' || node.content?.length);
  expect(filled.map((node) => node.type)).toEqual([
    'heading',
    'heading',
    'heading',
    'bulletList',
    'orderedList',
    'taskList',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'paragraph',
  ]);
  const ids = blocks(doc).map((node) => node.attrs?.id);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

const SLASH_CASES = [
  { query: 'text', title: 'Text', type: 'paragraph', selector: 'p' },
  { query: 'heading', title: 'Heading 1', type: 'heading', selector: 'h1' },
  { query: 'h2', title: 'Heading 2', type: 'heading', selector: 'h2' },
  { query: 'h3', title: 'Heading 3', type: 'heading', selector: 'h3' },
  { query: 'bul', title: 'Bulleted list', type: 'bulletList', selector: 'ul:not([data-type]) li' },
  { query: 'num', title: 'Numbered list', type: 'orderedList', selector: 'ol li' },
  { query: 'todo', title: 'To-do list', type: 'taskList', selector: '[data-type="taskList"] li' },
  { query: 'quote', title: 'Quote', type: 'blockquote', selector: 'blockquote' },
  { query: 'code', title: 'Code block', type: 'codeBlock', selector: 'pre' },
  { query: 'callout', title: 'Callout', type: 'callout', selector: '[data-type="callout"]' },
] as const;

for (const item of SLASH_CASES) {
  test(`slash menu inserts ${item.title}`, async ({ page }) => {
    const editor = await openPlayground(page);
    await page.keyboard.type(`/${item.query}`);
    const menu = page.getByRole('listbox', { name: 'Insert block' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option').first()).toContainText(item.title);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await page.keyboard.type('typed');
    await expect(editor.locator(item.selector).first()).toContainText('typed');
    const doc = await getJSON(page);
    expect(doc.content![0]!.type).toBe(item.type);
    expect(JSON.stringify(doc)).not.toContain(`/${item.query}`);
  });
}

test('slash menu inserts a divider and filters with keyboard navigation', async ({ page }) => {
  const editor = await openPlayground(page);
  await page.keyboard.type('/head');
  const options = page.getByRole('listbox', { name: 'Insert block' }).getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  // Combobox wiring for screen readers.
  const listboxId = await page.getByRole('listbox', { name: 'Insert block' }).getAttribute('id');
  await expect(editor).toHaveAttribute('aria-expanded', 'true');
  await expect(editor).toHaveAttribute('aria-controls', listboxId!);
  await expect(editor).toHaveAttribute(
    'aria-activedescendant',
    (await options.nth(2).getAttribute('id'))!,
  );
  await page.keyboard.press('Enter');
  await expect(editor).not.toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.type('Third level');
  await expect(editor.locator('h3')).toHaveText('Third level');

  await page.keyboard.press('Enter');
  await page.keyboard.type('/divider');
  await page.keyboard.press('Enter');
  await expect(editor.locator('hr')).toHaveCount(1);

  await page.keyboard.type('/nothing-matches');
  await expect(page.getByText('No matching blocks')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
});

test('@ mentions people from the suggestion callback', async ({ page }) => {
  const editor = await openPlayground(page);
  await page.keyboard.type('Ping @pri');
  const option = page.getByRole('option', { name: /Priya Natarajan/ });
  await expect(option).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor.locator('.oat-mention')).toHaveText('@Priya Natarajan');
  const doc = await getJSON(page);
  expect(doc.content![0]!.content).toContainEqual(
    expect.objectContaining({ type: 'mention', attrs: expect.objectContaining({ id: 'u_priya' }) }),
  );
});

test('bubble menu toggles marks and edits links', async ({ page }) => {
  const editor = await openPlayground(page);
  await page.keyboard.type('select me');
  await page.keyboard.press('Shift+Home');
  const toolbar = page.getByRole('toolbar', { name: 'Text formatting' });
  await expect(toolbar).toBeVisible();

  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await expect(editor.locator('strong')).toHaveText('select me');
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await toolbar.getByRole('button', { name: 'Highlight' }).click();
  await expect(editor.locator('mark')).toHaveText('select me');

  await toolbar.getByRole('button', { name: 'Add link' }).click();
  const url = toolbar.getByRole('textbox', { name: 'Link URL' });
  await url.fill('example.com/docs');
  await url.press('Enter');
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/docs');

  await toolbar.getByRole('button', { name: 'Remove link' }).click();
  await expect(editor.locator('a')).toHaveCount(0);

  // ⌘/Ctrl+K opens the link field directly.
  await editor.press('ControlOrMeta+k');
  await expect(toolbar.getByRole('textbox', { name: 'Link URL' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toolbar.getByRole('textbox', { name: 'Link URL' })).toBeHidden();
});

test('blocks keep unique ids; AI and my text render differently', async ({ page }) => {
  const editor = await openPlayground(page, { doc: 'sample' });
  const doc = await getJSON(page);
  const all = blocks(doc);
  const ids = all.map((node) => node.attrs?.id);
  expect(ids.every((id) => typeof id === 'string')).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(all.some((node) => node.attrs?.origin === 'ai')).toBe(true);
  expect(all.some((node) => node.attrs?.origin === 'me')).toBe(true);

  const mine = editor.locator(':scope > p[data-origin="me"]').first();
  const ai = editor.locator(':scope > p[data-origin="ai"]').first();
  const colour = (el: typeof mine) => el.evaluate((node) => getComputedStyle(node).color);
  const [myColour, aiColour] = await Promise.all([colour(mine), colour(ai)]);
  expect(myColour).not.toBe(aiColour);

  // Typing a new line after an AI paragraph: the new block is mine, with a fresh id.
  // (Caret placed via the API: End only reaches the end of the visual line in a wrapped paragraph.)
  await page.evaluate(() => {
    const e = window.__oatEditor!;
    let end = -1;
    e.state.doc.forEach((node, offset) => {
      if (end < 0 && node.type.name === 'paragraph' && node.attrs.origin === 'ai') {
        end = offset + node.nodeSize - 1;
      }
    });
    e.commands.focus(end);
  });
  await expect(editor).toBeFocused();
  // Wait for the deferred focus to settle on the requested caret before typing.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { selection, doc } = window.__oatEditor!.state;
        const $pos = doc.resolve(selection.from);
        return $pos.parent.attrs.origin === 'ai' && $pos.parentOffset === $pos.parent.content.size;
      }),
    )
    .toBe(true);
  await page.keyboard.press('Enter');
  await page.keyboard.type('My follow-up');
  await expect(editor.locator('p', { hasText: 'My follow-up' })).toBeVisible();
  const after = await getJSON(page);
  const index = after.content!.findIndex((node) =>
    node.content?.some((child) => child.text === 'My follow-up'),
  );
  expect(after.content![index - 1]!.attrs?.origin).toBe('ai');
  expect(after.content![index]!.attrs?.origin).toBe('me');
  const afterIds = blocks(after).map((node) => node.attrs?.id);
  expect(new Set(afterIds).size).toBe(afterIds.length);
  await expect(editor.locator('p', { hasText: 'My follow-up' })).toHaveCSS('color', myColour);
});

test('placeholder shows in an empty note', async ({ page }) => {
  const editor = await openPlayground(page);
  await expect(editor.locator('p.is-editor-empty')).toHaveAttribute(
    'data-placeholder',
    "Write, or type '/' for commands…",
  );
  await page.keyboard.type('# ');
  await expect(editor.locator('h1.is-empty')).toHaveAttribute('data-placeholder', 'Heading 1');
});
