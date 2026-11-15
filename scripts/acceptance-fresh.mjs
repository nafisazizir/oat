#!/usr/bin/env node
// `node scripts/acceptance-fresh.mjs`: proves the v1 acceptance journey (9.4) passes from a fresh clone, with
// no state from this checkout (no node_modules, no .env, no build output, no git-ignored files): clones the
// committed HEAD into a temp dir, then runs there
//
//   pnpm install --frozen-lockfile   (offline when the pnpm store already has the packages)
//   pnpm dev:up                      (the shared compose stack: a no-op when it is already healthy)
//   pnpm run ci --only acceptance
//
// and removes the clone. Only committed files are tested: uncommitted changes are reported and left out.
// Machine-wide caches are used as on any developer machine (pnpm store, Playwright's Chromium, Electron's
// download cache, the Docker images). See docs/DEV.md "Proving it works on a new machine".
//
//   --ref <rev>   commit to test (default HEAD)
//   --keep        keep the clone (prints its path) for debugging
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let ref = 'HEAD';
let keep = false;
const argv = process.argv.slice(2).filter((a) => a !== '--');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep') keep = true;
  else if (a === '--ref') ref = argv[++i] ?? '';
  else {
    console.error('usage: node scripts/acceptance-fresh.mjs [--ref <rev>] [--keep]');
    process.exit(2);
  }
}

/** @param {string[]} args */
function git(args, cwd = root) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Runs a command with inherited stdio in the clone. Resolves with the exit code.
 * @param {string} cmd @param {string[]} args @param {string} cwd
 */
function run(cmd, args, cwd) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}   (in ${cwd})`);
  return new Promise((resolve) => {
    // A clean environment for the app: nothing from this shell's DATABASE_URL & co. leaks in.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !/^(DATABASE_URL|REDIS_URL|MOCKS_URL|AI_|DEEPGRAM_|NOTION_|OAT_|BETTER_AUTH_)/.test(k),
      ),
    );
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env });
    child.on('error', (err) => {
      console.error(`acceptance-fresh: cannot run ${cmd}: ${err.message}`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]);
const dirty = git(['status', '--porcelain']);
if (dirty && ref === 'HEAD') {
  console.warn(
    `acceptance-fresh: uncommitted changes in ${root} are NOT part of the clone:\n${dirty}\n`,
  );
}

const base = mkdtempSync(join(tmpdir(), 'oat-fresh-'));
const clone = join(base, 'oat');
/** @type {{ phase: string, ms: number, code: number }[]} */
const phases = [];
let failed = false;
try {
  const t0 = performance.now();
  // A plain clone of this repository (any worktree shares its objects), then the exact commit.
  git(['clone', '--quiet', '--no-checkout', root, clone], base);
  git(['checkout', '--quiet', '--detach', sha], clone);
  phases.push({ phase: `clone ${sha.slice(0, 10)}`, ms: performance.now() - t0, code: 0 });

  for (const [phase, cmd, args] of /** @type {[string, string, string[]][]} */ ([
    ['pnpm install', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
    ['pnpm dev:up', 'pnpm', ['dev:up']],
    ['pnpm run ci --only acceptance', 'pnpm', ['run', 'ci', '--only', 'acceptance']],
  ])) {
    const started = performance.now();
    const code = await run(cmd, args, clone);
    phases.push({ phase, ms: performance.now() - started, code });
    if (code !== 0) {
      failed = true;
      break;
    }
  }
} catch (err) {
  console.error(`acceptance-fresh: ${err instanceof Error ? err.message : err}`);
  failed = true;
} finally {
  console.log('\n━━ acceptance-fresh summary');
  for (const p of phases)
    console.log(
      `${p.phase.padEnd(32)} ${p.code === 0 ? 'pass' : 'FAIL'}  ${(p.ms / 1000).toFixed(1).padStart(7)}s`,
    );
  if (keep) console.log(`clone kept at ${clone}`);
  else rmSync(base, { recursive: true, force: true });
}
console.log(failed ? '\nacceptance-fresh: FAILED' : '\nacceptance-fresh: ok');
process.exit(failed ? 1 : 0);
