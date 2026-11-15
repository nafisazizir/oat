import { describe, expect, it } from 'vitest';

import { safeUrl } from './notion';

describe('safeUrl', () => {
  it('keeps http(s) links from Notion and drops anything else', () => {
    expect(safeUrl('https://www.notion.so/Page-0123')).toBe('https://www.notion.so/Page-0123');
    expect(safeUrl('http://localhost:14010/notion/_mock/view/ab')).toBe(
      'http://localhost:14010/notion/_mock/view/ab',
    );
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('/relative')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});
