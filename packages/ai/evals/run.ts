/** Entry point for `pnpm --filter @oat/ai eval` / `eval:baseline` (see `src/evals/cli.ts`). */
import { existsSync } from 'node:fs';
import { runCli } from '../src/evals/cli.ts';
import { BASELINE_PATH, createSuites } from './index.ts';

// `--model real` may take its key from the repo-root `.env` (variables already set win). Mock runs ignore it.
const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

process.exitCode = await runCli(process.argv.slice(2), {
  suites: createSuites(),
  baselinePath: BASELINE_PATH,
});
