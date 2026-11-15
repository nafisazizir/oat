import { afterEach } from 'vitest';

// Only jsdom test files need DOM shims; Node schema tests skip all of this.
if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  // Vitest globals are off, so Testing Library can't register its own cleanup.
  afterEach(() => cleanup());

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};

  // ProseMirror measures text positions (coordsAtPos) for menus and scrolling; jsdom has no layout.
  const emptyRects = () => {
    const list: DOMRect[] = [];
    return Object.assign(list, { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Element.prototype.getClientRects ??= emptyRects;
  document.elementFromPoint ??= () => null;
}
