// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlockFocus } from './block-focus';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])(
  'scrolls to and briefly highlights the block (reduced motion: %s)',
  (reduce) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduce }));
    render(
      <>
        <div className="oat-editor">
          <p data-id="b">Cited</p>
        </div>
        <BlockFocus blockId="b" />
      </>,
    );
    const block = screen.getByText('Cited');
    expect(block.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth',
    });
    expect(block.hasAttribute('data-block-highlight')).toBe(true);
    act(() => vi.advanceTimersByTime(2400));
    expect(block.hasAttribute('data-block-highlight')).toBe(false);
  },
);

it('waits for an asynchronously mounted editor and clears the highlight on unmount', () => {
  const { rerender, unmount } = render(<BlockFocus blockId="b" />);
  act(() => vi.advanceTimersByTime(200));
  rerender(
    <>
      <div className="oat-editor">
        <p data-id="b">Late block</p>
      </div>
      <BlockFocus blockId="b" />
    </>,
  );
  act(() => vi.advanceTimersByTime(100));
  const block = screen.getByText('Late block');
  expect(block.hasAttribute('data-block-highlight')).toBe(true);
  unmount();
  expect(block.hasAttribute('data-block-highlight')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores an absent block id and stops polling for a missing target', () => {
  const { rerender } = render(<BlockFocus />);
  expect(vi.getTimerCount()).toBe(0);
  rerender(<BlockFocus blockId="missing" />);
  act(() => vi.advanceTimersByTime(5100));
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
