'use client';

import { useEffect } from 'react';

/** How long to wait for the editor to render the block (it mounts after hydration). */
const MAX_WAIT_MS = 5000;
const HIGHLIGHT_MS = 2400;

/**
 * Block links (`/d/<id>?block=<blockId>`, e.g. from My tasks, 8.4): once the note's editor shows the block,
 * scrolls it into view and highlights it briefly (`data-block-highlight`, styled by `@oat/editor/styles.css`).
 * Renders nothing; a missing block is ignored.
 */
export function BlockFocus({ blockId }: { blockId?: string | null }) {
  useEffect(() => {
    if (!blockId) return;
    const selector = `.oat-editor [data-id="${CSS.escape(blockId)}"]`;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let clear: ReturnType<typeof setTimeout> | undefined;
    let highlighted: HTMLElement | undefined;
    const find = () => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) {
        if (performance.now() - started < MAX_WAIT_MS) timer = setTimeout(find, 100);
        return;
      }
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      element.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      element.setAttribute('data-block-highlight', '');
      highlighted = element;
      clear = setTimeout(() => element.removeAttribute('data-block-highlight'), HIGHLIGHT_MS);
    };
    find();
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
      highlighted?.removeAttribute('data-block-highlight');
    };
  }, [blockId]);

  return null;
}
