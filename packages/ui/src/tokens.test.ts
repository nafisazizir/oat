import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8');
const tokens = read('tokens.css');
const styles = read('styles.css');
const variables = (body: string) =>
  new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const light = variables(tokens.slice(0, tokens.indexOf('.dark')));
const dark = variables(tokens.slice(tokens.indexOf('.dark')));

describe('oat palette', () => {
  it('defines the same ramp in both themes', () => {
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(light.size).toBeGreaterThan(100);
    for (const name of light.keys()) expect(name).toMatch(/^--ds-/);
    expect(light.get('--ds-background-100')).toBe('oklch(0.982 0.002 84)');
    expect(dark.get('--ds-background-100')).not.toBe(light.get('--ds-background-100'));
  });

  it('loads the oat overrides after ziiz and keeps the legacy slot bridge', () => {
    const imports = [...styles.matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
    expect(imports.slice(0, 6)).toEqual([
      'tailwindcss',
      'tw-animate-css',
      'shadcn/tailwind.css',
      '@nafisazizir/ziiz/theme.css',
      './tokens.css',
      '@nafisazizir/ziiz/shadcn.css',
    ]);
    expect(styles).toContain("@source './'");
    expect(styles).toContain('@custom-variant dark (&:is(.dark *))');
  });

  it('maps every brand step including alpha, 950 and on to Tailwind', () => {
    const brand = [...light.keys()].filter((name) => name.startsWith('--ds-brand-'));
    expect(brand).toHaveLength(22);
    for (const name of brand) expect(styles).toContain(`--color-${name.slice(5)}: var(${name})`);
  });

  it('uses bundled Inter and JetBrains Mono and retains the editor serif', () => {
    expect(styles).toContain('@fontsource-variable/inter/wght.css');
    expect(styles).toContain('@fontsource-variable/jetbrains-mono/wght.css');
    expect(styles).toContain('@fontsource-variable/newsreader/opsz.css');
    expect(styles).not.toMatch(/https?:\/\/|instrument-sans/);
  });

  it('maps status and AI text roles to readable ramp steps in both themes', () => {
    for (const [role, ramp] of Object.entries({
      destructive: 'red-900',
      success: 'green-900',
      warning: 'amber-1000',
      'ai-text': 'blue-900',
    })) {
      expect(styles).toContain(`--${role}: var(--ds-${ramp})`);
    }
    expect(styles).toContain(':root,\n.dark {');
  });
});

const forbidden = [
  /#[0-9a-fA-F]{3,8}\b/,
  /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(/,
  /\b(?:bg|text|border|ring|fill|stroke|outline|from|via|to|divide|placeholder|caret|accent|decoration|shadow)-(?:slate|zinc|neutral|stone|orange|yellow|lime|emerald|cyan|sky|indigo|violet|fuchsia|rose)-\d+\b/,
  /\b(?:bg|text|border|ring|fill|stroke|outline|from|via|to|divide|placeholder|caret|accent|decoration|shadow)-\[(?:#|color:|[a-zA-Z-]+(?:\(|\]))/,
];

describe('ziiz component vocabulary', () => {
  const sources = readdirSync(join(import.meta.dirname, 'components')).filter((name) =>
    name.endsWith('.tsx'),
  );
  it('includes the registry beyond the original controls', () => {
    expect(sources).toContain('calendar.tsx');
    expect(sources).toContain('toast.tsx');
    expect(sources).not.toContain('chart.tsx');
    expect(sources).not.toContain('carousel.tsx');
  });
  it.each(sources)('%s uses ramp colours, not colour literals or stock palettes', (name) => {
    const code = read('components/' + name);
    for (const pattern of forbidden) expect(code).not.toMatch(pattern);
    expect(code).not.toMatch(/@\/|from ['"]cn['"]/);
  });
  it('re-exports the ziiz merge utility', () => {
    expect(read('lib/utils.ts')).toContain("export { cn } from '@nafisazizir/ziiz/cn'");
  });
});
