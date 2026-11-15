#!/usr/bin/env node
// `pnpm run ci`: every gate the factory relies on, identical on a laptop and in GitHub Actions (D-12,
// docs/FACTORY.md §3, docs/DEV.md "CI"). Plain Node, no shell-isms, no dependencies.
//
//   pnpm run ci                       full run
//   pnpm run ci --fast                format, actionlint, typecheck, lint, test (no stack, no e2e, no Swift)
//   pnpm run ci --only test:int       just these steps (comma-separated or repeated; a group name such as
//                                     `swift` selects all its steps). Does not add prerequisites: use
//                                     `--only stack,test:int` if the stack may be down.
//   pnpm run ci --bail                stop at the first failure (default: run every independent step)
//   pnpm run ci --list                print the steps
//
// Steps run in order. A step whose prerequisite failed is skipped. Prints a summary table with durations and
// exits non-zero if anything failed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const oatAudio = join(root, 'native', 'oat-audio');
const isMac = process.platform === 'darwin';

// Pinned actionlint image (same version locally and in CI). Bump deliberately.
const ACTIONLINT_IMAGE = 'rhysd/actionlint:1.7.12';
// Compose Postgres (D-11). The migrate check creates its own throwaway database there.
const PG_HOST_URL = 'postgres://oat:oat@localhost:54329';

/** Thrown by a step to mark itself skipped instead of failed. */
class Skip extends Error {}

/**
 * Runs a command with inherited stdio (`capture`: return stdout; `quiet`: swallow output; `input`: feed
 * stdin). Resolves with the exit code (127 if the binary is missing).
 * @param {string} cmd @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, capture?: boolean, quiet?: boolean, input?: string }} [opts]
 * @returns {Promise<{ code: number, stdout: string }>}
 */
function run(cmd, args, opts = {}) {
  if (!opts.capture && !opts.quiet) console.log(`$ ${[cmd, ...args].join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? root,
      env: { ...process.env, ...opts.env },
      stdio: [
        opts.input !== undefined ? 'pipe' : opts.capture || opts.quiet ? 'ignore' : 'inherit',
        opts.capture || opts.quiet ? 'pipe' : 'inherit',
        opts.quiet ? 'pipe' : 'inherit',
      ],
    });
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}); // child may exit without reading it all
      child.stdin?.end(opts.input);
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr?.resume();
    child.on('error', (err) => {
      if (!opts.quiet) console.error(`ci: cannot run ${cmd}: ${err.message}`);
      resolve({
        code: /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' ? 127 : 1,
        stdout,
      });
    });
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stdout }));
  });
}

/** @param {string} cmd @param {string[]} args @param {Parameters<typeof run>[2]} [opts] */
async function must(cmd, args, opts) {
  const { code, stdout } = await run(cmd, args, opts);
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${code}`);
  return stdout;
}

const pnpm = (/** @type {string[]} */ ...args) => must('pnpm', args);

async function hasDocker() {
  return (
    (await run('docker', ['version', '--format', '{{.Server.Version}}'], { quiet: true })).code ===
    0
  );
}

/** Services defined in docker-compose.yml (default profile) vs. running + healthy ones. */
async function stackHealth() {
  const services = (await must('docker', ['compose', 'config', '--services'], { capture: true }))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const raw = (
    await must('docker', ['compose', 'ps', '--format', 'json'], { capture: true })
  ).trim();
  // Compose ≥ 2.21 prints one JSON object per line; older versions print a single array.
  /** @type {{ Service: string, State: string, Health: string }[]} */
  const containers = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
  const unhealthy = services.filter(
    (s) =>
      !containers.some(
        (c) =>
          c.Service === s && c.State === 'running' && (c.Health === 'healthy' || c.Health === ''),
      ),
  );
  return { services, unhealthy };
}

/** SQL against the compose Postgres as the superuser, via the container's psql (no host client needed). */
function psql(/** @type {string} */ database, /** @type {string} */ sql) {
  return must(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'oat',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
    ].concat(['-tA', '-c', sql]),
    { capture: true },
  );
}

/** A free TCP port on 127.0.0.1 (so parallel worktrees never fight over one). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Workspace packages that define an `e2e` script. */
async function e2ePackages() {
  const out = await must('pnpm', ['m', 'ls', '--json', '--depth=-1'], { capture: true });
  /** @type {{ name: string, path: string }[]} */
  const pkgs = JSON.parse(out);
  return pkgs.filter((p) => {
    const file = join(p.path, 'package.json');
    if (p.path === root || !existsSync(file)) return false;
    return Boolean(JSON.parse(readFileSync(file, 'utf8')).scripts?.e2e);
  });
}

/** `producer | consumer`, both with a timeout. Resolves when both exit; throws if either fails. */
function pipe(
  /** @type {[string, string[]]} */ producer,
  /** @type {[string, string[]]} */ consumer,
  /** @type {string} */ cwd,
  timeoutMs = 60_000,
) {
  console.log(`$ ${producer.flat().join(' ')} | ${consumer.flat().join(' ')}`);
  return new Promise((resolve, reject) => {
    const a = spawn(producer[0], producer[1], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    const b = spawn(consumer[0], consumer[1], { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    a.stdout.pipe(b.stdin);
    b.stdin.on('error', () => {}); // consumer may exit early (EPIPE); its exit code tells the story
    const timer = setTimeout(() => {
      a.kill('SIGKILL');
      b.kill('SIGKILL');
    }, timeoutMs);
    /** @type {(number | null)[]} */
    const codes = [];
    const done = (/** @type {number} */ i) => (/** @type {number | null} */ code) => {
      codes[i] = code;
      if (codes[0] === undefined || codes[1] === undefined) return;
      clearTimeout(timer);
      if (codes[0] === 0 && codes[1] === 0) resolve(undefined);
      else
        reject(
          new Error(`pipeline exited with ${codes[0]} | ${codes[1]} (timeout ${timeoutMs} ms)`),
        );
    };
    for (const [i, child] of [a, b].entries()) {
      child.on('error', (err) => {
        clearTimeout(timer);
        a.kill();
        b.kill();
        reject(err);
      });
      child.on('close', done(i));
    }
  });
}

/**
 * @typedef {{ name: string, group?: string, slow?: boolean, needs?: string, macOnly?: boolean,
 *   about: string, run: () => Promise<unknown> }} Step
 */

/** @type {Step[]} */
const steps = [
  { name: 'format', about: 'prettier --check', run: () => pnpm('run', 'format:check') },
  {
    name: 'actionlint',
    about: `lint .github/workflows (${ACTIONLINT_IMAGE} via docker)`,
    async run() {
      if (!(await hasDocker())) throw new Skip('docker not available');
      // Each file goes in on stdin rather than bind-mounting the checkout: Docker Desktop may not be
      // allowed to share the repo's folder (macOS privacy, e.g. ~/Documents), and nothing else is needed.
      const dir = join(root, '.github', 'workflows');
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
      if (files.length === 0) throw new Error(`no workflow files in ${dir}`);
      const failed = [];
      for (const f of files) {
        const rel = `.github/workflows/${f}`;
        const args = ['run', '-i', '--rm', ACTIONLINT_IMAGE, '-color', '-stdin-filename', rel, '-'];
        const { code } = await run('docker', args, { input: readFileSync(join(dir, f), 'utf8') });
        if (code === 0) console.log(`actionlint: ${rel} ok`);
        else failed.push(rel);
      }
      if (failed.length) throw new Error(`actionlint found problems in ${failed.join(', ')}`);
    },
  },
  { name: 'typecheck', about: 'turbo run typecheck', run: () => pnpm('run', 'typecheck') },
  { name: 'lint', about: 'turbo run lint + eslint scripts/', run: () => pnpm('run', 'lint') },
  { name: 'test', about: 'unit tests (turbo run test)', run: () => pnpm('run', 'test') },
  {
    name: 'stack',
    slow: true,
    about:
      'compose stack healthy (no-op if it is; else `dev:up`, which builds images only if missing)',
    async run() {
      const before = await stackHealth();
      if (before.unhealthy.length === 0) {
        console.log(`stack: all ${before.services.length} services healthy — nothing to do`);
        return;
      }
      console.log(`stack: not healthy/running: ${before.unhealthy.join(', ')} → pnpm dev:up`);
      await must('node', [join(root, 'scripts', 'dev.mjs'), 'up']);
    },
  },
  {
    name: 'migrate',
    slow: true,
    needs: 'stack',
    about: '@oat/db db:migrate on a throwaway database, twice (idempotent), row count = journal',
    async run() {
      // Same naming as @oat/testkit, so a leaked database is swept by the next test:int run.
      const name = `oat_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
      const journal = JSON.parse(
        readFileSync(join(root, 'packages/db/drizzle/meta/_journal.json'), 'utf8'),
      );
      await psql('postgres', `CREATE DATABASE "${name}"`);
      try {
        const env = { DATABASE_URL: `${PG_HOST_URL}/${name}` };
        await must('pnpm', ['--filter', '@oat/db', 'run', 'db:migrate'], { env });
        await must('pnpm', ['--filter', '@oat/db', 'run', 'db:migrate'], { env });
        const out = await psql(name, 'select count(*) from drizzle.__drizzle_migrations');
        const applied = Number(out.trim());
        if (applied !== journal.entries.length)
          throw new Error(`applied ${applied} migrations, journal has ${journal.entries.length}`);
        console.log(
          `migrate: ${applied}/${journal.entries.length} migrations applied, re-run no-op`,
        );
      } finally {
        await psql('postgres', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) =>
          console.error(`migrate: could not drop ${name} (swept later): ${err.message}`),
        );
      }
    },
  },
  {
    name: 'test:int',
    slow: true,
    needs: 'stack',
    about: 'integration tests against the stack',
    run: () => pnpm('run', 'test:int'),
  },
  {
    name: 'e2e',
    slow: true,
    needs: 'stack',
    about: 'each package `e2e` script (Playwright), own free port in E2E_PORT',
    async run() {
      const pkgs = await e2ePackages();
      if (pkgs.length === 0) throw new Skip('no package defines an e2e script');
      const failed = [];
      for (const p of pkgs) {
        const port = String(await freePort());
        console.log(`e2e: ${p.name} on E2E_PORT=${port}`);
        const { code } = await run('pnpm', ['--filter', p.name, 'run', 'e2e'], {
          env: { E2E_PORT: port },
        });
        if (code !== 0) failed.push(p.name);
      }
      if (failed.length) throw new Error(`failing package(s): ${failed.join(', ')}`);
    },
  },
  {
    name: 'swift:build',
    group: 'swift',
    slow: true,
    macOnly: true,
    about: 'native/oat-audio swift build',
    run: () => must('swift', ['build'], { cwd: oatAudio }),
  },
  {
    name: 'swift:test',
    group: 'swift',
    slow: true,
    macOnly: true,
    needs: 'swift:build',
    about: 'native/oat-audio swift test',
    run: () => must('swift', ['test'], { cwd: oatAudio }),
  },
  {
    name: 'swift:synthetic',
    group: 'swift',
    slow: true,
    macOnly: true,
    needs: 'swift:build',
    about: 'oat-audio capture --synthetic | check-frames.mjs (no hardware, no permission prompt)',
    async run() {
      const bin = (
        await must('swift', ['build', '--show-bin-path'], { cwd: oatAudio, capture: true })
      )
        .trim()
        .split('\n')
        .at(-1);
      if (!bin) throw new Error('swift build --show-bin-path printed nothing');
      await pipe(
        [join(bin, 'oat-audio'), ['capture', '--synthetic', '--duration', '2']],
        [process.execPath, ['scripts/check-frames.mjs', '--expect-seconds', '2']],
        oatAudio,
      );
    },
  },
];

function usage() {
  const width = Math.max(...steps.map((s) => s.name.length));
  return [
    'usage: node scripts/ci.mjs [--fast] [--only <step|group>[,...]] [--bail] [--list]',
    '',
    'steps (in order; * = skipped by --fast, mac = macOS only):',
    ...steps.map(
      (s) =>
        `  ${s.name.padEnd(width)}  ${s.slow ? '*' : ' '} ${s.macOnly ? 'mac' : '   '}  ${s.about}`,
    ),
  ].join('\n');
}

// --- args ----------------------------------------------------------------------------------------------
const argv = process.argv.slice(2).filter((a) => a !== '--'); // `pnpm run ci -- --fast` also works
let fast = false;
let bail = false;
/** @type {string[]} */
const only = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fast') fast = true;
  else if (a === '--bail') bail = true;
  else if (a === '--list' || a === '--help' || a === '-h') {
    console.log(usage());
    process.exit(0);
  } else if (a === '--only' || a.startsWith('--only=')) {
    const value = a === '--only' ? argv[++i] : a.slice('--only='.length);
    if (!value) {
      console.error(`ci: --only needs a value\n\n${usage()}`);
      process.exit(2);
    }
    only.push(...value.split(',').filter(Boolean));
  } else {
    console.error(`ci: unknown argument ${a}\n\n${usage()}`);
    process.exit(2);
  }
}
const known = new Set(steps.flatMap((s) => [s.name, s.group ?? s.name]));
const unknown = only.filter((o) => !known.has(o));
if (unknown.length) {
  console.error(`ci: unknown step(s) ${unknown.join(', ')}\n\n${usage()}`);
  process.exit(2);
}
if (fast && only.length) {
  console.error('ci: use either --fast or --only');
  process.exit(2);
}

// --- run -----------------------------------------------------------------------------------------------
/** @type {{ name: string, status: 'pass' | 'FAIL' | 'skip', ms: number, note: string }[]} */
const results = [];
const statusOf = (/** @type {string} */ name) => results.find((r) => r.name === name)?.status;
const started = performance.now();

for (const step of steps) {
  const selected = only.length
    ? only.includes(step.name) || (step.group !== undefined && only.includes(step.group))
    : !(fast && step.slow);
  if (!selected) continue;

  /** @type {string | undefined} */
  let skip;
  if (step.macOnly && !isMac) skip = 'not macOS';
  else if (bail && results.some((r) => r.status === 'FAIL')) skip = 'bail: earlier failure';
  else if (step.needs && statusOf(step.needs) && statusOf(step.needs) !== 'pass')
    skip = `${step.needs} did not pass`;
  if (skip) {
    results.push({ name: step.name, status: 'skip', ms: 0, note: skip });
    continue;
  }

  console.log(`\n━━ ci: ${step.name} — ${step.about}`);
  const t0 = performance.now();
  try {
    await step.run();
    results.push({ name: step.name, status: 'pass', ms: performance.now() - t0, note: '' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof Skip ? 'skip' : 'FAIL';
    if (status === 'FAIL') console.error(`ci: ${step.name} failed: ${msg}`);
    results.push({ name: step.name, status, ms: performance.now() - t0, note: msg });
  }
}

const fmt = (/** @type {number} */ ms) => (ms === 0 ? '-' : `${(ms / 1000).toFixed(1)}s`);
const width = Math.max(4, ...results.map((r) => r.name.length));
console.log(
  `\n━━ ci summary${fast ? ' (--fast)' : only.length ? ` (--only ${only.join(',')})` : ''}`,
);
console.log(`${'step'.padEnd(width)}  status  ${'time'.padStart(7)}  note`);
for (const r of results)
  console.log(
    `${r.name.padEnd(width)}  ${r.status.padEnd(6)}  ${fmt(r.ms).padStart(7)}  ${r.note}`,
  );
console.log(`${'total'.padEnd(width)}          ${fmt(performance.now() - started).padStart(7)}`);

const failed = results.filter((r) => r.status === 'FAIL');
if (failed.length) {
  console.error(`\nci: FAILED (${failed.map((r) => r.name).join(', ')})`);
  process.exit(1);
}
console.log('\nci: ok');
