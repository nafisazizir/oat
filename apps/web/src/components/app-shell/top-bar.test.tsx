import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TopBarActions, TopBarProvider } from './top-bar';

vi.mock('@oat/ui/components/sidebar', () => ({
  SidebarTrigger: () => <button>Toggle sidebar</button>,
  useSidebar: () => ({ open: false, isMobile: false }),
}));
vi.mock('./new-note-button', () => ({ NewNoteButton: () => <button>New note</button> }));
vi.mock('@oat/ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: () => null,
}));

describe('top bar action slot', () => {
  it('renders a stable empty target and content before the client attaches', () => {
    const html = renderToStaticMarkup(
      <TopBarProvider>
        <main>Page</main>
        <TopBarActions>
          <button>Share</button>
        </TopBarActions>
      </TopBarProvider>,
    );
    expect(html).toContain('data-testid="top-bar-actions"');
    expect(html).toContain('Toggle sidebar');
    expect(html).not.toContain('New note');
    expect(html).toContain('<main>Page</main>');
    expect(html).not.toContain('Share');
    expect(html).not.toContain('border-b');
  });

  it('is safe outside the shell (error and signed-out surfaces)', () => {
    expect(renderToStaticMarkup(<TopBarActions>Share</TopBarActions>)).toBe('');
  });
});
