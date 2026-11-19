import { renderToStaticMarkup } from 'react-dom/server';
import type { ToasterProps } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { Toaster } from './components/sonner.tsx';

vi.mock('sonner', () => ({
  Toaster: ({ style, toastOptions }: ToasterProps) => (
    <div style={style} data-toast-class={toastOptions?.classNames?.toast} />
  ),
}));

describe('Sonner surface', () => {
  it('uses ramp variables and the floating modal material instead of shadcn slots', () => {
    const html = renderToStaticMarkup(<Toaster />);
    expect(html).toContain('--normal-bg:var(--ds-background-100)');
    expect(html).toContain('--normal-text:var(--ds-gray-1000)');
    expect(html).toContain('--normal-border:transparent');
    expect(html).toContain('material-modal!');
    expect(html).not.toContain('var(--popover');
    expect(html).not.toContain('var(--border)');
  });
});
