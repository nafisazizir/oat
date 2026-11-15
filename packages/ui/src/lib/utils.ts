/**
 * `cn()` — merge class names, resolving Tailwind conflicts (last one wins).
 *
 * Backed by shadcn's `cn` package (clsx + tailwind-merge semantics, compiled). Every component in
 * this package imports it from here, so swapping the implementation is a one-line change.
 *
 * Note: tailwind-merge only knows Tailwind's built-in scale names. Our type scale therefore reuses
 * the stock names (`text-xs` … `text-4xl`) with token-driven values instead of inventing
 * `text-<custom>` sizes, which would be mis-merged as colours.
 */
export { cn } from 'cn';
