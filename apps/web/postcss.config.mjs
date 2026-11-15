import { join } from 'node:path';

// Tailwind v4 via PostCSS. The theme itself comes from `@oat/ui/styles.css` (see src/app/globals.css).
export default {
  plugins: {
    '@tailwindcss/postcss': {
      // Scan (and ask the bundler to watch) only `src/`, not the whole app folder with `.next/`,
      // `test-results/` etc. (1.4 design notes: a dev reload loop was seen once; this narrows the
      // watch set). Turbopack evaluates this file without `import.meta.dirname`; `next dev|build`
      // always run from this folder.
      base: join(process.cwd(), 'src'),
    },
  },
};
