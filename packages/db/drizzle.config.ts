import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit (generate/studio) runs outside Vitest; pick up the repo-root `.env` like the CLIs do.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL || 'postgres://oat:oat@localhost:54329/oat' },
  strict: true,
  verbose: true,
});
