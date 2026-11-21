import { afterEach } from 'vitest';

// Only jsdom test files need DOM shims.
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
  Element.prototype.scrollTo ??= function scrollTo() {};
}
