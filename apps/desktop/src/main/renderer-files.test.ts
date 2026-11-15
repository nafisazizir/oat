import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mimeType, resolveRendererFile } from './renderer-files.ts';

const ROOT = '/app/out/renderer';

describe('resolveRendererFile', () => {
  it('maps app://oat paths into the renderer folder', () => {
    expect(resolveRendererFile(ROOT, 'app://oat/')).toBe(join(ROOT, 'index.html'));
    expect(resolveRendererFile(ROOT, 'app://oat/index.html#/main')).toBe(join(ROOT, 'index.html'));
    expect(resolveRendererFile(ROOT, 'app://oat/assets/a%20b.js?x=1')).toBe(
      join(ROOT, 'assets/a b.js'),
    );
  });

  it('dot segments are resolved by URL parsing and clamp at the renderer root', () => {
    expect(resolveRendererFile(ROOT, 'app://oat/../main/index.js')).toBe(
      join(ROOT, 'main/index.js'),
    );
    expect(resolveRendererFile(ROOT, 'app://oat/%2e%2e/main/index.js')).toBe(
      join(ROOT, 'main/index.js'),
    );
  });

  it.each([
    'app://oat/assets/..%2f..%2fmain%2findex.js',
    'app://oat/%2e%2e%5cmain',
    'app://oat/a%00.js',
    'app://oat/%E0%A4%A',
    'app://other/index.html',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resolveRendererFile(ROOT, url)).toBeNull();
  });

  it('serves known types with the right content type', () => {
    expect(mimeType('index.html')).toMatch(/^text\/html/);
    expect(mimeType('a.JS')).toMatch(/^text\/javascript/);
    expect(mimeType('font.woff2')).toBe('font/woff2');
    expect(mimeType('x.exe')).toBe('application/octet-stream');
  });
});
