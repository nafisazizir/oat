import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Acceptance "no hard-coded colours outside @oat/ui tokens": app sources may only use token
 * utilities (ziiz ramps and legacy slots), never colour literals or non-ziiz Tailwind palettes.
 * Same rules as @oat/ui's tokens.test.ts, applied to apps/web/src.
 */
const srcDir = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const palette =
  'slate|zinc|neutral|stone|orange|yellow|lime|emerald|cyan|sky|indigo|violet|fuchsia|rose';
const forbidden: [string, RegExp][] = [
  ['hex colour', /#[0-9a-fA-F]{3,8}\b(?![\w-])/],
  ['colour function', /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/],
  ['Tailwind palette colour', new RegExp(`\\b[a-z-]+-(?:${palette})-\\d{2,3}\\b`)],
  ['black/white utility', /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:black|white)\b/],
  [
    'arbitrary colour value',
    /\b(?:bg|text|border|ring|fill|stroke|outline|from|via|to|divide|placeholder|caret|accent|decoration|shadow)-\[(?:#|color:|[a-zA-Z-]+(?:\(|\]))/,
  ],
];

describe('apps/web uses design tokens only', () => {
  const files = sourceFiles(srcDir);

  it('finds the sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const [what, pattern] of forbidden) {
    it(`no ${what}`, () => {
      const hits = files.flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => pattern.test(line))
          .map(({ line, index }) => `${relative(srcDir, file)}:${index + 1}: ${line.trim()}`),
      );
      expect(hits).toEqual([]);
    });
  }
});
