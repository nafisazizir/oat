// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConflictCompareDialog, ConflictNotice, type ConflictComparison } from './conflicts';
afterEach(cleanup);
const data: ConflictComparison = {
  original: [
    { text: 'Other title', changed: false },
    { text: 'Other text', changed: true },
  ],
  copy: [
    { text: 'Copy title', changed: false },
    { text: 'Copy text', changed: true },
  ],
  canKeepCopy: true,
  canKeepOriginal: true,
};
it('shares status and comparison triggers with both hosts', () => {
  const compare = vi.fn();
  render(
    <ConflictNotice title="Conflicted copy" onCompare={compare}>
      Both versions were kept.
    </ConflictNotice>,
  );
  expect(screen.getByRole('status').textContent).toContain('Both versions');
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(compare).toHaveBeenCalledOnce();
});
it('renders changed lines and explicitly selects each local/server resolution', () => {
  const keep = vi.fn();
  render(
    <ConflictCompareDialog open onOpenChange={vi.fn()} pending={null} data={data} onKeep={keep} />,
  );
  expect(screen.getByTestId('compare-copy').textContent).toContain('Copy text');
  expect(screen.getByText('Other text').className).toContain('bg-amber-200');
  fireEvent.click(screen.getByRole('button', { name: 'Keep this copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep other version' }));
  expect(keep.mock.calls).toEqual([['copy'], ['original']]);
});
it('keeps empty bodies readable and missing originals non-replaceable', () => {
  render(
    <ConflictCompareDialog
      open
      onOpenChange={vi.fn()}
      pending={null}
      data={{ ...data, original: null, copy: [], canKeepCopy: false }}
      onKeep={vi.fn()}
    />,
  );
  expect(screen.getByText('The note this was copied from is gone.')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Keep this copy' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('exposes load errors with retry instead of keeping the skeleton forever', () => {
  const retry = vi.fn();
  render(
    <ConflictCompareDialog
      open
      onOpenChange={vi.fn()}
      pending={null}
      loadError="Couldn’t load this copy."
      onRetry={retry}
      onKeep={vi.fn()}
    />,
  );
  expect(screen.getByText('Couldn’t load this copy.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole('button', { name: 'Keep this copy' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('blocks permission-restricted and pending resolution actions and shows their status', () => {
  const keep = vi.fn();
  render(
    <ConflictCompareDialog
      open
      onOpenChange={vi.fn()}
      pending="original"
      data={{ ...data, canKeepCopy: false, permissionMessage: 'You can’t edit the note.' }}
      onKeep={keep}
      error="Resolve failed."
    />,
  );
  expect(screen.getByText('Resolve failed.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep this copy' }));
  fireEvent.click(screen.getByRole('button', { name: /Keep other version/ }));
  expect(keep).not.toHaveBeenCalled();
});
