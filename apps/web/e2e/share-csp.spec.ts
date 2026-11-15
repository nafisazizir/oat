import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { apiCreateDocument, apiUpdateDocument } from './docs-helpers';
import { expect, hydrationAware, test } from './fixtures';

/**
 * 9.3 (5.3 follow-up): the public share page under its strict nonce CSP in a **production** build, in a real
 * browser. `next dev` needs `'unsafe-eval'` and serves scripts differently, so only `next build && next start`
 * shows whether every script the page needs (Next's chunks and inline payload, the theme script by hash)
 * actually runs. Opt-in, it builds the app first:
 *   E2E_PORT=3107 pnpm --filter @oat/web e2e:prod
 */
test.skip(process.env.OAT_E2E_PROD !== '1', 'production build only (pnpm e2e:prod)');

const EVIDENCE = fileURLToPath(new URL('../../../docs/tasks/evidence/9.3/', import.meta.url));

const NOTE = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ship the share viewer this week.' }] },
  ],
};

test('share page runs under its CSP in a production build: no violations, hydrated, theme works', async ({
  page,
  browser,
}) => {
  await page.goto('/home');
  const doc = await apiCreateDocument(page, { title: 'Production share' });
  expect(
    (await apiUpdateDocument(page, doc.id, { baseVersion: 0, contentJson: NOTE })).status(),
  ).toBe(200);
  const share = await page.request.patch(`/api/documents/${doc.id}/share`, {
    data: { visibility: 'link' },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(share.status()).toBe(200);
  const { sharePath } = (await share.json()) as { sharePath: string };

  // A stranger, dark system theme: the head script (allowed by its hash) must set `.dark` before paint.
  const context = await browser.newContext({ colorScheme: 'dark' });
  const anon = hydrationAware(await context.newPage());
  const problems: string[] = [];
  anon.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text());
  });
  anon.on('pageerror', (e) => problems.push(e.message));
  await anon.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  const res = await anon.goto(sharePath);
  expect(res?.status()).toBe(200);
  const csp = res!.headers()['content-security-policy']!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toContain('unsafe-eval');

  // Scripts ran: React hydrated (the marker is set by client code) and the theme script applied `.dark`.
  await expect(anon.locator('html[data-hydrated]')).toBeAttached();
  await expect(anon.locator('html')).toHaveClass(/\bdark\b/);
  await expect(
    anon
      .getByTestId('shared-document')
      .getByRole('heading', { level: 1, name: 'Production share' }),
  ).toBeVisible();

  mkdirSync(EVIDENCE, { recursive: true });
  await anon.screenshot({ path: `${EVIDENCE}prod-share-csp.png` });

  // Client interaction works: the theme menu switches to light.
  await anon.getByTestId('theme-menu').click();
  await anon.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(anon.locator('html')).not.toHaveClass(/\bdark\b/);

  const violations = await anon.evaluate(
    () => (window as unknown as { __csp?: string[] }).__csp ?? [],
  );
  expect(violations, 'CSP violations').toEqual([]);
  expect(problems, 'console errors').toEqual([]);
  await context.close();
});
