import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = fileURLToPath(new URL('../src', import.meta.url));

// Gallery: `pnpm --filter @oat/ui gallery` → http://localhost:5199
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    // Package self-references (`@oat/ui/components/button`) resolve straight to source.
    alias: [{ find: /^@oat\/ui\//, replacement: `${src}/` }],
  },
  server: { port: 5199, strictPort: true },
});
