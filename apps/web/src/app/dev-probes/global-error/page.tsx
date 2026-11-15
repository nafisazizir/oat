import { notFound } from 'next/navigation';

/**
 * Dev/test hook for `global-error.tsx`: no `error.tsx` sits above this route, so the throw reaches the
 * root boundary, like an error in the root or `(app)` layout would. A plain 404 in production.
 */
export default function GlobalErrorProbe() {
  if (process.env.NODE_ENV === 'production') notFound();
  throw new Error('Global-error probe: this page always fails in development.');
}
