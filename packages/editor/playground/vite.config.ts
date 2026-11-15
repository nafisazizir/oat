import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { PLAYGROUND_PORT } from './port.ts';

// Editor playground: `pnpm --filter @oat/editor playground` → http://localhost:5201
// Query params: ?theme=light|dark · ?doc=empty|sample · ?readonly=1
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: { port: PLAYGROUND_PORT, strictPort: true },
});
