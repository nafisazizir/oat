import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ColourTokens, TypeScale } from '../gallery/sections/tokens.tsx';

describe('ziiz gallery', () => {
  it('shows all eleven ramps without legacy slot variables', () => {
    const html = renderToStaticMarkup(<ColourTokens />);
    for (const ramp of [
      'background',
      'gray',
      'gray-alpha',
      'brand',
      'blue',
      'red',
      'amber',
      'green',
      'teal',
      'purple',
      'pink',
    ]) {
      expect(html).toContain(`aria-label="${ramp} ramp"`);
      expect(html).toContain(`var(--ds-${ramp}-100)`);
    }
    expect(html).not.toContain('--background)');
    expect(html).not.toContain('--chart-');
    expect(html).not.toContain('--ds-background-300');
  });

  it('shows the 31 ziiz roles and four display roles with button roles on buttons only', () => {
    const html = renderToStaticMarkup(<TypeScale />);
    expect(html.match(/<p class="text-/g)).toHaveLength(32);
    for (const size of [14, 20, 24, 32]) expect(html).toContain(`text-display-${size}`);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('text-heading-72');
    expect(html).toContain('text-copy-13-mono');
    expect(html).not.toMatch(/<p class="text-button-/);
  });
});
