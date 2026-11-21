import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { asciiSlug, createFileNamer, safeBaseName } from './names';
import { readZip } from './read-zip';
import { ZipWriter } from './zip';

function archive(files: Array<[string, string]>, at = new Date('2026-11-21T10:20:30Z')) {
  const zip = new ZipWriter();
  const parts = files.map(([name, text]) => zip.add(name, text, at));
  parts.push(zip.finish());
  return Buffer.concat(parts);
}

describe('ZipWriter', () => {
  it('writes an archive that reads back: names, text, time, checksums', () => {
    const long = 'Lorem ipsum dolor sit amet. '.repeat(4000);
    const files = readZip(
      archive([
        ['Plan.md', '# Plan\n\nShip it.\n'],
        ['Žluťoučký kůň – 日本語 🌾.md', 'Unicode names and text: ‘ok’ ✓\n'],
        ['Empty.md', ''],
        ['Long.md', long],
      ]),
    );
    expect(files.map((f) => f.name)).toEqual([
      'Plan.md',
      'Žluťoučký kůň – 日本語 🌾.md',
      'Empty.md',
      'Long.md',
    ]);
    expect(files[0]!.text).toBe('# Plan\n\nShip it.\n');
    expect(files[1]!.text).toBe('Unicode names and text: ‘ok’ ✓\n');
    expect(files[2]!.text).toBe('');
    expect(files[3]!.text).toBe(long);
    expect(files[0]!.modifiedAt.toISOString()).toBe('2026-11-21T10:20:30.000Z');
  });

  it('compresses, and counts what it wrote', () => {
    const zip = new ZipWriter();
    const part = zip.add('a.md', 'a'.repeat(100_000));
    expect(part.length).toBeLessThan(2000);
    const tail = zip.finish();
    expect(zip.size).toBe(part.length + tail.length);
  });

  it('an empty archive is still an archive', () => {
    expect(readZip(archive([]))).toEqual([]);
  });

  it('refuses names that could leave the folder, whatever the caller passes', () => {
    const zip = new ZipWriter();
    for (const name of [
      '',
      '/etc/passwd',
      '../up.md',
      'a/../../b.md',
      'a\\b.md',
      './x',
      'a//b',
      'x\0y',
    ]) {
      expect(() => zip.add(name, 'x'), name).toThrow(/unsafe/);
    }
    expect(readZip(Buffer.concat([zip.finish()]))).toEqual([]);
  });

  it('cannot be added to or finished twice', () => {
    const zip = new ZipWriter();
    zip.finish();
    expect(() => zip.add('a.md', 'x')).toThrow(/finished/);
    expect(() => zip.finish()).toThrow(/finished/);
  });

  // The reader above was written next to the writer; this asks an independent implementation. (Checked
  // by hand as well: Python's `zipfile` and macOS `ditto -x -k` read the Unicode names.)
  const unzip = spawnSync('unzip', ['-v']).status === 0;
  it.skipIf(!unzip)('is accepted by the system `unzip`, which extracts the same files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oat-zip-'));
    try {
      // Integrity (sizes, checksums) of an archive with non-ASCII names…
      const unicode = join(dir, 'unicode.zip');
      writeFileSync(unicode, archive([['Čaj 🌾.md', 'tea\n']]));
      execFileSync('unzip', ['-tq', unicode]);
      // …and a real extraction (ASCII names: Info-ZIP writes names in the process locale).
      const file = join(dir, 'notes.zip');
      writeFileSync(
        file,
        archive([
          ['Plan.md', '# Plan\n'],
          ['Plan (2).md', 'x'.repeat(5000)],
        ]),
      );
      execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')]);
      expect(readdirSync(join(dir, 'out')).toSorted()).toEqual(['Plan (2).md', 'Plan.md']);
      expect(readFileSync(join(dir, 'out', 'Plan.md'), 'utf8')).toBe('# Plan\n');
      expect(readFileSync(join(dir, 'out', 'Plan (2).md'), 'utf8')).toBe('x'.repeat(5000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('safeBaseName', () => {
  it('keeps ordinary titles, Unicode included', () => {
    expect(safeBaseName('Weekly sync — Q4 plan')).toBe('Weekly sync — Q4 plan');
    expect(safeBaseName('日本語のメモ')).toBe('日本語のメモ');
    expect(safeBaseName('  spaced   out  ')).toBe('spaced out');
  });

  it('never yields a path: separators, dots and traversal are neutralised', () => {
    const hostile = [
      '../../etc/passwd',
      '..\\..\\Windows\\system32',
      '/absolute/path',
      'C:\\Users\\me',
      '..',
      '.',
      '.hidden',
      '....',
      'a/b/c',
      'nul\0byte',
      'line\nbreak\ttab',
      'right\u202eto-left',
      'zero\u200bwidth',
      '~/.ssh/id_rsa',
      '%2e%2e%2f',
    ];
    for (const title of hostile) {
      const name = safeBaseName(title);
      expect(name, title).not.toMatch(/[\\/:*?"<>|]/);
      expect(name, title).not.toMatch(/^\./);
      expect(name, title).not.toMatch(/[.\s]$/);
      expect(name, title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(name.length, title).toBeGreaterThan(0);
      // And the archive writer accepts it as a single path segment.
      expect(() => new ZipWriter().add(`${name}.md`, '')).not.toThrow();
    }
    expect(safeBaseName('../../etc/passwd')).toBe('etc passwd');
    expect(safeBaseName('..')).toBe('Untitled');
    expect(safeBaseName('.hidden')).toBe('hidden');
  });

  it('falls back for empty titles and avoids reserved device names', () => {
    expect(safeBaseName('')).toBe('Untitled');
    expect(safeBaseName('   ')).toBe('Untitled');
    expect(safeBaseName('???')).toBe('Untitled');
    expect(safeBaseName('CON')).toBe('_CON');
    expect(safeBaseName('nul')).toBe('_nul');
    expect(safeBaseName('LPT1')).toBe('_LPT1');
    expect(safeBaseName('Console')).toBe('Console');
  });

  const bytes = (name: string) => new TextEncoder().encode(name).length;

  it('caps the length in UTF-8 bytes, never splits a character, never ends on a dot or space', () => {
    expect(safeBaseName('x'.repeat(500))).toBe('x'.repeat(200));
    // 4-byte characters: 50 of them, not 80 (which would be 320 bytes).
    expect(safeBaseName('😀'.repeat(100))).toBe('😀'.repeat(50));
    // 3-byte characters, and a cut that would fall inside one.
    expect(bytes(safeBaseName('日'.repeat(300)))).toBe(198);
    expect(safeBaseName(`${'x'.repeat(199)}日本`)).toBe('x'.repeat(199));
    expect(safeBaseName(`${'x'.repeat(199)}. tail`)).toBe('x'.repeat(199));
    for (const title of ['😀'.repeat(300), '日'.repeat(300), 'é'.repeat(300), 'x'.repeat(300)]) {
      expect(bytes(safeBaseName(title)), title.slice(0, 4)).toBeLessThanOrEqual(200);
      // Still whole characters: encoding and decoding gives the same text back.
      const name = safeBaseName(title);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(name))).toBe(
        name,
      );
      expect(name.isWellFormed()).toBe(true);
    }
  });

  it('treats a device name as reserved with any extensions after it', () => {
    expect(safeBaseName('con.notes')).toBe('_con.notes');
    expect(safeBaseName('NUL.tar.gz')).toBe('_NUL.tar.gz');
    expect(safeBaseName('aux .txt')).toBe('_aux .txt');
    expect(safeBaseName('COM1.md')).toBe('_COM1.md');
    // Not device names.
    expect(safeBaseName('console.log')).toBe('console.log');
    expect(safeBaseName('my.con')).toBe('my.con');
  });
});

describe('createFileNamer', () => {
  it('numbers duplicates, also when they differ only by case or were made equal by cleaning', () => {
    const name = createFileNamer();
    expect(name('Plan')).toBe('Plan.md');
    expect(name('Plan')).toBe('Plan (2).md');
    expect(name('plan')).toBe('plan (3).md');
    expect(name('Pl/an')).toBe('Pl an.md');
    expect(name('Pl:an')).toBe('Pl an (2).md');
    expect(name('')).toBe('Untitled.md');
    expect(name('')).toBe('Untitled (2).md');
    // A title that looks like an earlier numbered name can't take its place.
    expect(name('Plan (2)')).toBe('Plan (2) (2).md');
  });

  it('keeps every name well under 255 bytes, extension and duplicate number included', () => {
    const name = createFileNamer();
    const title = '😀'.repeat(100);
    const names = Array.from({ length: 1200 }, () => name(title));
    expect(new Set(names).size).toBe(1200);
    expect(names.at(-1)).toBe(`${'😀'.repeat(50)} (1200).md`);
    for (const n of names) expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(210);
    expect(name('con.notes')).toBe('_con.notes.md');
  });
});

describe('asciiSlug', () => {
  it('makes a header-safe part of the download name', () => {
    expect(asciiSlug('Acme Design')).toBe('acme-design');
    expect(asciiSlug('Ada’s workspace')).toBe('ada-s-workspace');
    expect(asciiSlug('"; filename=evil')).toBe('filename-evil');
    expect(asciiSlug('日本語')).toBe('workspace');
    expect(asciiSlug('x'.repeat(100))).toHaveLength(40);
  });
});
