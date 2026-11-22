import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ShellHeader } from './shell-header';

const sidebar = vi.hoisted(() => ({ open: true, isMobile: false }));
vi.mock('@oat/ui/components/sidebar', () => ({
  useSidebar: () => sidebar,
  SidebarTrigger: () => <button>Toggle sidebar</button>,
}));

describe('shared shell header', () => {
  it.each([
    [true, false, false],
    [false, false, true],
    [true, true, true],
  ])(
    'shows the collapse control only when needed (open %s, mobile %s)',
    (open, isMobile, visible) => {
      Object.assign(sidebar, { open, isMobile });
      const html = renderToStaticMarkup(
        <ShellHeader>
          <button>Share</button>
        </ShellHeader>,
      );
      expect(html.includes('Toggle sidebar')).toBe(visible);
      expect(html).toContain('h-12');
      expect(html).toContain('Share');
    },
  );
});
