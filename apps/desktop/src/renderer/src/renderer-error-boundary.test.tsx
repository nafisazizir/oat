// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RendererErrorBoundary } from './renderer-error-boundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'oat');
});
it('recovers with Retry without sending any recording command', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const invoke = vi.fn();
  Object.defineProperty(window, 'oat', { value: { invoke }, configurable: true });
  let broken = true;
  function Child() {
    if (broken) throw new Error('Renderer failed');
    return <p>Recovered shell</p>;
  }
  render(
    <RendererErrorBoundary>
      <Child />
    </RendererErrorBoundary>,
  );
  expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
  expect(screen.getByText(/Any recording keeps running/)).toBeTruthy();
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('Recovered shell')).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
});
it('reloads only the renderer and keeps a repeated failure recoverable', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const reload = vi.fn();
  function Child(): never {
    throw Object.assign(new Error('Renderer failed'), { digest: 'reference' });
  }
  render(
    <RendererErrorBoundary reload={reload}>
      <Child />
    </RendererErrorBoundary>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText('Reference reference')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledOnce();
});
it.each([null, undefined, 'Failure'])(
  'recovers when a child throws a non-Error value: %s',
  (value) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Child(): never {
      throw value;
    }
    render(
      <RendererErrorBoundary>
        <Child />
      </RendererErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
  },
);
