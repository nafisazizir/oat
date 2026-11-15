/**
 * Integration-test harness (not exported): builds the eve app once and runs its server (what `eve start` runs) on
 * a free port, against a throwaway app database, a throwaway Workflow-world database (both on the compose
 * Postgres), the compose Redis and an in-process mocks server. No network beyond loopback (D-11), no telemetry.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';

import { AGENTS_DIR, buildAgent as build } from '../cli/build.ts';

/** `.env.example`: the dev defaults (the stack's ports, the dev auth secret, the mock OAuth client). */
export function devEnv(): Record<string, string> {
  const parsed = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}

/** `eve build` with telemetry off and no model-catalog fetch (see src/cli/build.ts). */
export const buildAgent = () => build({ quiet: true });

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface AgentServer {
  url: string;
  /** stdout + stderr so far (diagnostics on failure). */
  output(): string;
  /** SIGKILL of the server: no shutdown hooks, in-flight work abandoned (the crash test). */
  kill(): Promise<void>;
  /** The same (the tests need no graceful shutdown; the server's own SIGTERM handling can take 25 s). */
  stop(): Promise<void>;
}

/**
 * Runs the built server (what `eve start` runs: `node .output/server/index.mjs` with the host/port variables and
 * without `TEST`/`CI`) under a tiny supervisor that SIGKILLs it when told to (SIGTERM) *or when its stdin
 * closes*, i.e. when the test process dies in any way, even SIGKILL. A server that outlives its test would keep
 * polling the Workflow world and holding connections on the shared Postgres.
 */
const SUPERVISOR = `
const { spawn } = require('node:child_process');
const server = spawn(process.execPath, [process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('SIGTERM', stop);
process.stdin.on('close', stop).on('end', stop).resume();
server.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;

/**
 * Starts the built server and resolves once `/eve/v1/health` answers. `schedules: true` lets it fire its
 * schedules (the post-meeting backstop sweep, every minute) like `eve start` does.
 */
export async function startAgent(
  env: Record<string, string>,
  port: number,
  options: { schedules?: boolean } = {},
): Promise<AgentServer> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    EVE_TELEMETRY_DISABLED: '1',
    ...(options.schedules ? {} : { EVE_SCHEDULES_DISABLED: '1' }),
    HOST: '127.0.0.1',
    NITRO_HOST: '127.0.0.1',
    PORT: String(port),
    NITRO_PORT: String(port),
  };
  for (const name of [
    'TEST',
    'CI',
    'SERVER_SHUTDOWN_TIMEOUT',
    'NITRO_UNIX_SOCKET',
    ...(options.schedules ? ['EVE_SCHEDULES_DISABLED'] : []),
  ]) {
    delete childEnv[name];
  }
  const child: ChildProcess = spawn(
    process.execPath,
    ['-e', SUPERVISOR, `${AGENTS_DIR}/.output/server/index.mjs`],
    { cwd: AGENTS_DIR, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (d: string) => (output += d));
  child.stderr?.setEncoding('utf8').on('data', (d: string) => (output += d));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const killServer = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const res = await fetch(`${url}/eve/v1/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await killServer();
      throw new Error(`server not healthy after 60 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    output: () => output,
    kill: killServer,
    stop: killServer,
  };
}
