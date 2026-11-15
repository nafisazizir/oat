import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcDir = import.meta.dirname;
const read = (file: string) => readFileSync(join(srcDir, file), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared directly inside the first `<selector> { … }` block. */
function declaredIn(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const tokens = stripComments(read('tokens.css'));
const styles = stripComments(read('styles.css'));
const light = declaredIn(tokens, ':root');
const dark = declaredIn(tokens, '.dark');
const theme = declaredIn(styles, '@theme inline');

const componentDir = join(srcDir, 'components');
const componentSources = readdirSync(componentDir)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => ({ file: f, code: readFileSync(join(componentDir, f), 'utf8') }));

/** `--color-x: var(--y)` → { x: 'y' } */
const colourMap = new Map(
  [...theme]
    .filter(([name]) => name.startsWith('--color-'))
    .map(([name, value]) => [name.slice('--color-'.length), /var\((--[\w-]+)\)/.exec(value)?.[1]]),
);

describe('tokens.css', () => {
  it('defines every colour token in both light and dark', () => {
    const isColour = (value: string) => /oklch\(|var\(--/.test(value) && !value.includes('cubic');
    const lightColours = [...light].filter(([, v]) => isColour(v)).map(([k]) => k);
    const missingInDark = lightColours.filter(
      (k) => !dark.has(k) && !k.startsWith('--font') && !k.startsWith('--elevation'),
    );
    expect(missingInDark).toEqual([]);
    const missingInLight = [...dark.keys()].filter((k) => !light.has(k));
    expect(missingInLight).toEqual([]);
  });

  it('every Tailwind colour in styles.css maps to a token defined in both themes', () => {
    expect(colourMap.size).toBeGreaterThan(30);
    for (const [name, token] of colourMap) {
      expect(token, `--color-${name}`).toBeDefined();
      expect(light.has(token!), `${token} in :root`).toBe(true);
      expect(dark.has(token!), `${token} in .dark`).toBe(true);
    }
  });

  it('every theme mapping points at a declared token', () => {
    for (const [name, value] of theme) {
      for (const m of value.matchAll(/var\((--[\w-]+)\)/g)) {
        expect(light.has(m[1]!), `${name} → ${m[1]}`).toBe(true);
      }
    }
  });

  it('declares the app-specific tokens', () => {
    for (const t of ['--me', '--them', '--my-text', '--ai-text', '--sidebar', '--overlay']) {
      expect(light.has(t) && dark.has(t), t).toBe(true);
    }
  });
});

describe('component sources', () => {
  it('contain no colour literals', () => {
    for (const { file, code } of componentSources) {
      expect(code, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(|hsla?\(/);
    }
  });

  it('use no Tailwind default-palette colours (only token colours)', () => {
    const palette =
      /\b(?:bg|text|border|ring|fill|stroke|outline|from|via|to|divide|placeholder|caret|accent|decoration|shadow)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/;
    for (const { file, code } of componentSources) expect(code, file).not.toMatch(palette);
  });

  it('only reference colour utilities that exist as tokens', () => {
    const prefixes = '(?:bg|text|border|ring|fill|stroke|outline|divide|placeholder|caret)';
    const known = new Set(colourMap.keys());
    const notColour =
      /^(?:xs|sm|base|lg|xl|\d?xl|left|right|center|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|none|solid|dashed|dotted|hidden|current|transparent|inherit|inset|offset-\d+|\d+|\[.*\]|[xytblrse](?:-\d+)?|\d+\.\d+|clip-padding|blend-[\w-]+)$/;
    const unknown: string[] = [];
    for (const { file, code } of componentSources) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w-])${prefixes}-([a-z][\\w-]*)`, 'g'))) {
        // `border-t-x` / `ring-offset-x` carry the colour after the side/offset segment.
        const name = m[1]!.replace(/\/\d+$/, '').replace(/^(?:offset|[trblxyse])-(?=[a-z])/, '');
        if (!notColour.test(name) && !known.has(name)) unknown.push(`${file}: ${m[0]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('only reference CSS variables that are tokens, theme values or set by the component', () => {
    const declared = new Set([...light.keys(), ...theme.keys()]);
    const missing: string[] = [];
    for (const { file, code } of componentSources) {
      const setInline = new Set([...code.matchAll(/['"](--[\w-]+)['"]:/g)].map((m) => m[1]!));
      for (const m of code.matchAll(/var\((--[\w-]+)/g)) {
        const name = m[1]!;
        if (name.startsWith('--radix-') || name.startsWith('--tw-')) continue;
        if (!declared.has(name) && !setInline.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('use motion, type and radius tokens instead of raw values', () => {
    const raw: [string, RegExp][] = [
      ['raw duration (use duration-fast|base|slow)', /(?<![\w-])duration-\d/],
      ['stock easing (use ease-standard|enter|exit)', /(?<![\w-])ease-(?:linear|in|out|in-out)\b/],
      ['arbitrary font size (use the type scale)', /(?<![\w-])text-\[/],
      [
        'capped/literal radius (use rounded-*)',
        /(?<![\w-])rounded-(?:[trblse]{1,2}-)?\[(?:min\(|\d)/,
      ],
    ];
    const hits: string[] = [];
    for (const { file, code } of componentSources) {
      for (const [why, re] of raw) {
        const m = new RegExp(re.source, 'g');
        for (const hit of code.matchAll(m)) hits.push(`${file}: ${why}: ${hit[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ── Contrast (WCAG 2.x) computed from the oklch token values ───────────────────────────────────

type Rgba = { r: number; g: number; b: number; a: number }; // gamma-encoded sRGB, 0..1

function parseColour(vars: Map<string, string>, token: string): Rgba {
  const value = vars.get(token) ?? light.get(token);
  if (!value) throw new Error(`unknown token ${token}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (alias) return parseColour(vars, alias[1]!);
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/.exec(value);
  if (!m) throw new Error(`${token}: cannot parse ${value}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const [r, g, bl] = linear.map(encode) as [number, number, number];
  return { r, g, b: bl, a: m[4] === undefined ? 1 : Number(m[4]) / 100 };
}

/** Composite `top` (with an extra alpha, like Tailwind's `/10`) over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba, alpha = 1): Rgba {
  const a = top.a * alpha;
  const mix = (t: number, u: number) => t * a + u * (1 - a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba) {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(x: Rgba, y: Rgba) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` on `bg`; `bg` may be a tint (`bg/tint`) laid over `surface`. */
type Pair = { fg: string; bg: string; tint?: number; surface?: string };

const textPairs: Pair[] = [
  { fg: '--foreground', bg: '--background' },
  { fg: '--card-foreground', bg: '--card' },
  { fg: '--popover-foreground', bg: '--popover' },
  { fg: '--primary-foreground', bg: '--primary' },
  { fg: '--primary', bg: '--background' }, // links
  { fg: '--secondary-foreground', bg: '--secondary' },
  { fg: '--muted-foreground', bg: '--background' },
  { fg: '--muted-foreground', bg: '--card' },
  { fg: '--muted-foreground', bg: '--muted' }, // inactive tabs
  { fg: '--muted-foreground', bg: '--accent' },
  { fg: '--accent-foreground', bg: '--accent' },
  { fg: '--destructive-foreground', bg: '--destructive' },
  { fg: '--warning-foreground', bg: '--warning' },
  { fg: '--sidebar-foreground', bg: '--sidebar' },
  { fg: '--sidebar-accent-foreground', bg: '--sidebar-accent' },
  { fg: '--me-foreground', bg: '--me' },
  { fg: '--them-foreground', bg: '--them' },
  { fg: '--my-text', bg: '--background' },
  { fg: '--ai-text', bg: '--background' },
  { fg: '--ai-text', bg: '--card' },
];

// Destructive text on its own tint (button/badge rest + hover, menu item focus): tint alphas per theme.
const destructiveTints = { light: [0.1, 0.2], dark: [0.2, 0.25] } as const;

// UI component boundaries (WCAG 1.4.11): ≥ 3:1.
const boundaryPairs: Pair[] = [
  { fg: '--input', bg: '--background' },
  { fg: '--input', bg: '--card' },
  { fg: '--ring', bg: '--background' },
  { fg: '--ring', bg: '--card' },
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('contrast (%s)', (name, vars) => {
  const colour = (t: string) => parseColour(vars, t);
  const ratio = ({ fg, bg, tint, surface }: Pair) => {
    const back = over(colour(bg), colour(surface ?? bg), tint ?? 1);
    return contrastRatio(over(colour(fg), back), back);
  };

  it.each(textPairs.map((p) => [`${p.fg} on ${p.bg}`, p] as const))(
    'text %s ≥ 4.5:1',
    (_label, pair) => {
      expect(ratio(pair)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('destructive text on its tint ≥ 4.5:1 (rest + hover, on page, card and menu)', () => {
    for (const surface of ['--background', '--card', '--popover']) {
      for (const tint of destructiveTints[name]) {
        const r = ratio({ fg: '--destructive', bg: '--destructive', tint, surface });
        expect(r, `${surface} /${tint}: ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(boundaryPairs.map((p) => [`${p.fg} on ${p.bg}`, p] as const))(
    'boundary %s ≥ 3:1',
    (_label, pair) => {
      expect(ratio(pair)).toBeGreaterThanOrEqual(3);
    },
  );
});
