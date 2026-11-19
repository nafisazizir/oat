import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');
const aliases = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];
const slot = `(?:${aliases.join('|')})`;
const bridgeReference = new RegExp(
  `(?<![\\w-])(?:bg|text|border|ring(?:-offset)?|inset-ring|fill|stroke|outline|divide|from|to|via|placeholder|caret|accent|decoration|shadow)(?:-[xytrblse])?-${slot}(?![\\w-])|--(?:color-)?${slot}(?![\\w-])`,
);
const rawType = /(?<![\w-])(?:text-xs|text-sm|text-base|font-medium|font-semibold)(?![\w-])/;
const generated = new Set(['node_modules', 'dist', 'out', '.next', '.turbo', 'coverage']);

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return generated.has(entry.name) ? [] : sources(path);
    return /\.(?:[cm]?[jt]sx?|css)$/.test(entry.name) &&
      !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const workspaces = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, group, entry.name)),
);
const files = workspaces.flatMap((workspace) =>
  ['src', 'gallery', 'playground'].flatMap((dir) => sources(join(workspace, dir))),
);

function findings(pattern: RegExp, candidates: string[]) {
  return candidates.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
}

describe('repository ziiz vocabulary', () => {
  it('recognizes every bridge slot, including modifiers and variable forms', () => {
    expect(aliases).toHaveLength(31);
    for (const alias of aliases) {
      expect(`hover:bg-${alias}/50`).toMatch(bridgeReference);
      expect(`var(--${alias}, transparent)`).toMatch(bridgeReference);
      expect(`text-(--${alias})`).toMatch(bridgeReference);
      expect(`var(--color-${alias})`).toMatch(bridgeReference);
    }
  });

  it.each([
    '',
    'bg-background-100',
    'text-gray-900',
    'border-gray-alpha-400',
    'ring-3',
    'var(--sidebar-width)',
    'var(--sidebar-width-icon)',
    'var(--ds-background-100)',
    'var(--color-background-100)',
  ])('allows ramp and layout vocabulary: %s', (code) => {
    expect(code).not.toMatch(bridgeReference);
  });

  it('finds app, editor, meeting-ui, registry and preview sources', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(
      files.some((file) =>
        relative(root, file)
          .split('/')
          .some((part) => generated.has(part)),
      ),
    ).toBe(false);
    for (const file of [
      'apps/web/src/app/(app)/home/page.tsx',
      'apps/desktop/src/renderer/src/windows/main-window.tsx',
      'packages/editor/src/styles.css',
      'packages/editor/playground/main.tsx',
      'packages/meeting-ui/src/participants.tsx',
      'packages/ui/src/components/sonner.tsx',
      'packages/ui/gallery/sections/tokens.tsx',
    ]) {
      expect(files).toContain(join(root, file));
    }
  });

  it('has no bridge aliases in production sources, including registry and previews', () => {
    expect(findings(bridgeReference, files)).toEqual([]);
  });

  it('uses type roles outside registry components', () => {
    const text = files.filter(
      (file) =>
        file.endsWith('.tsx') && !relative(root, file).startsWith('packages/ui/src/components/'),
    );
    expect(findings(rawType, text)).toEqual([]);
  });

  it('has no Lucide imports, dependencies or catalog entry', () => {
    const manifests = [
      join(root, 'package.json'),
      join(root, 'pnpm-workspace.yaml'),
      ...workspaces.map((dir) => join(dir, 'package.json')).filter(existsSync),
    ];
    expect(findings(/lucide-react/, [...files, ...manifests])).toEqual([]);
  });
});
