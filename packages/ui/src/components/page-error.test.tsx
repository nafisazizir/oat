import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PageError, errorDigest } from './page-error';
afterEach(cleanup);
it('shares the error message and only invokes the supplied host recovery callbacks', () => {
  const retry = vi.fn(),
    reload = vi.fn();
  render(
    <PageError
      onRetry={retry}
      onReload={reload}
      digest="reference"
      home={<a href="/home">Go home</a>}
    />,
  );
  expect(screen.getByText('This page couldn’t load. Try again, or head back home.')).toBeTruthy();
  expect(screen.getByText('Reference reference')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' }).className).toContain('bg-gray-100');
  expect(screen.getByRole('button', { name: 'Reload' }).className).not.toContain(
    'bg-background-100',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Go home' }).getAttribute('href')).toBe('/home');
});
it('keeps unavailable recovery actions and unknown error details out of the UI', () => {
  render(<PageError onRetry={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  expect(screen.queryByText(/Reference/)).toBeNull();
  expect(errorDigest(null)).toBeUndefined();
  expect(errorDigest('error')).toBeUndefined();
  expect(errorDigest({ digest: 1 })).toBeUndefined();
  expect(errorDigest({ digest: 'reference' })).toBe('reference');
});
it('keeps recovery actions compact for a widget-sized renderer', () => {
  render(<PageError compact onRetry={vi.fn()} onReload={vi.fn()} />);
  expect(screen.getByRole('alert').className).toContain('p-2');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.queryByText(/This page couldn’t load/)).toBeNull();
});
