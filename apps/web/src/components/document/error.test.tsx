import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import AppError from '@/app/(app)/error';

it('keeps the web retry and Home adapter around the shared recovery message', () => {
  const html = renderToStaticMarkup(<AppError error={{ digest: 'reference' }} retry={vi.fn()} />);
  expect(html).toContain('Something went wrong');
  expect(html).toContain('Reference reference');
  expect(html).toContain('href="/home"');
  expect(renderToStaticMarkup(<AppError error={null} retry={vi.fn()} />)).not.toContain(
    'Reference',
  );
});
