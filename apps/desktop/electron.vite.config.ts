import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * electron-vite: `src/main` (ESM), `src/preload` (CJS, one self-contained file: sandboxed preloads can't
 * `require` anything but `electron`), `src/renderer` (React + @oat/ui). Output in `out/`.
 *
 * D-15: `@oat/*` packages are TypeScript source, so nothing is externalised: main and preload bundle
 * every dependency (only `electron` and Node built-ins stay external). That also keeps the packaged app
 * (9.1) free of a runtime `node_modules`.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rolldownOptions: { input: 'src/main/index.ts' },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: 'src/preload/index.ts',
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // electron-vite leaves output unminified; the renderer is worth minifying (parse time at launch).
    // Root and input are electron-vite's defaults (`src/renderer`, `index.html`).
    build: { minify: true },
    server: { strictPort: false },
  },
});
