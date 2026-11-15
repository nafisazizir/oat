/**
 * Screenshot the gallery in light + dark with Playwright.
 *
 *   pnpm --filter @oat/ui screenshots [outDir]      (default: docs/tasks/evidence/1.3)
 *
 * Starts the gallery's Vite dev server in-process, so nothing else needs to be running.
 * Needs Chromium once: `pnpm --filter @oat/ui exec playwright install chromium`.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = resolve(process.argv[2] ?? resolve(here, '../../../docs/tasks/evidence/1.3'));
mkdirSync(outDir, { recursive: true });

const server = await createServer({
  configFile: resolve(here, 'vite.config.ts'),
  server: { port: 5198, strictPort: false },
  logLevel: 'warn',
});
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:5198/';

const browser = await chromium.launch();
const shots: string[] = [];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // let enter animations finish
}

try {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });

    // Full gallery with floating overlays pinned open. Grow the viewport to the page height so
    // fixed-position overlays (popovers, toasts) are captured where they were laid out.
    await page.goto(`${base}?theme=${theme}&static=1`);
    await settle(page);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 1440, height });
    await settle(page);
    const full = resolve(outDir, `gallery-${theme}.png`);
    await page.screenshot({ path: full });
    shots.push(full);

    // Modal surfaces: dialog and sheet, at a normal viewport.
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [name, trigger] of [
      ['dialog', 'Share…'],
      ['sheet', 'Attendees'],
    ] as const) {
      await page.goto(`${base}?theme=${theme}`);
      await settle(page);
      await page.getByRole('button', { name: trigger }).scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: trigger }).click();
      await page.getByRole('dialog').waitFor();
      await settle(page);
      const file = resolve(outDir, `${name}-${theme}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(shots.join('\n'));
