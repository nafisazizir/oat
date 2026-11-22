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

function luminance(value: string) {
  const [lightness, C, h] = value
    .match(/[\d.]+%?/g)!
    .map((number) =>
      number.endsWith('%') ? Number(number.slice(0, -1)) / 100 : Number(number),
    ) as [number, number, number];
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return (
    0.2126 * (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * (-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

describe('Graphite palette', () => {
  it.each(['background-100', 'background-200', 'gray-100', 'gray-200'])(
    'keeps gray-900 text AA on %s',
    (background) => {
      for (const theme of [light, dark]) {
        const fg = luminance(theme.get('--ds-gray-900')!);
        const bg = luminance(theme.get(`--ds-${background}`)!);
        expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
  it('defines the same ramp in both themes', () => {
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(light.size).toBeGreaterThan(100);
    for (const name of light.keys()) expect(name).toMatch(/^--ds-/);
    expect(light.get('--ds-background-100')).toBe('oklch(1 0 0)');
    expect(dark.get('--ds-background-100')).toBe('oklch(0.213 0 0)');
  });

  it('keeps search highlight text AA on its amber background in both themes', () => {
    for (const theme of [light, dark]) {
      const fg = luminance(theme.get('--ds-gray-1000')!);
      const bg = luminance(theme.get('--ds-amber-300')!);
      expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('loads the oat overrides after ziiz without the legacy slot bridge', () => {
    const imports = [...styles.matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
    expect(imports.slice(0, 5)).toEqual([
      'tailwindcss',
      'tw-animate-css',
      'shadcn/tailwind.css',
      '@nafisazizir/ziiz/theme.css',
      './tokens.css',
    ]);
    expect(imports).not.toContain('@nafisazizir/ziiz/shadcn.css');
    expect(styles).toContain("@source './'");
    expect(styles).toContain('@custom-variant dark (&:is(.dark *))');
  });

  it('maps every brand step including alpha, 950 and on to Tailwind', () => {
    const brand = [...light.keys()].filter((name) => name.startsWith('--ds-brand-'));
    expect(brand).toHaveLength(22);
    for (const name of brand) expect(styles).toContain(`--color-${name.slice(5)}: var(${name})`);
    for (const theme of [light, dark]) {
      expect(theme.get('--ds-brand-700')).toBe('var(--ds-gray-1000)');
      expect(theme.get('--ds-brand-800')).toBe('var(--ds-gray-950, var(--ds-gray-1000))');
      expect(theme.get('--ds-brand-on')).toBe('var(--ds-background-100)');
    }
  });

  it('uses bundled Inter, Geist Mono and Newsreader', () => {
    expect(styles).toContain('@fontsource-variable/inter/wght.css');
    expect(styles).toContain('@fontsource-variable/geist-mono/wght.css');
    expect(styles).toContain('@fontsource-variable/newsreader/opsz.css');
    expect(styles).not.toMatch(/https?:\/\/|instrument-sans/);
  });

  it('maps status and AI text roles to readable ramp steps in both themes', () => {
    for (const [role, ramp] of Object.entries({
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
    expect(sources).toContain('chart.tsx');
    expect(sources).toContain('carousel.tsx');
  });
  it.each(sources)('%s uses ramp colours, not colour literals or stock palettes', (name) => {
    // Recharts selectors match library-generated SVG attributes. The styles themselves use the ramp.
    const code = read('components/' + name).replaceAll(/\[stroke='#[\da-f]{3}'\]/gi, '');
    for (const pattern of forbidden) expect(code).not.toMatch(pattern);
    expect(code).not.toMatch(/@\/|from ['"]cn['"]/);
  });
  it('re-exports the ziiz merge utility', () => {
    expect(read('lib/utils.ts')).toContain("export { cn } from '@nafisazizir/ziiz/cn'");
  });
});
