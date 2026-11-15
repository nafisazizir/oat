/**
 * `SidecarMicAppsSource`: mic-using processes from `oat-audio mic-apps …` (Core Audio process objects in the
 * Swift sidecar; protocol in `native/oat-audio/PROTOCOL.md` → "Mic apps"). Node-only (child processes);
 * import it from `@oat/detection/node`.
 *
 * Safety: with `fixture` the sidecar replays a timeline file and touches no Core Audio at all. Without it the
 * sidecar reads Core Audio process-object metadata (no capture, no tap); its first real run is a human
 * checkpoint, so tests always pass `fixture`.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { locateSidecarBinary, SidecarError, type SidecarBinary } from '@oat/audio/node';

import type { MicAppProcess } from './apps.ts';
import { parseApps, type MicAppsSource, type MicAppsWatch } from './source.ts';

export interface SidecarMicAppsSourceOptions {
  /** Default: `locateSidecarBinary()` (`OAT_AUDIO_BIN`, packaged resources, dev build). */
  binary?: SidecarBinary;
  /** Replay `steps[].micApps` of this detection timeline instead of Core Audio (`--fixture`). */
  fixture?: string;
  env?: NodeJS.ProcessEnv;
  /** `watch --interval-ms`. Default: the sidecar's (1000 ms). */
  intervalMs?: number;
  /** Timeout for `list`. Default 10 s. */
  timeoutMs?: number;
  /** Time allowed for `watch` to print `ready`. Default 10 s. */
  readyTimeoutMs?: number;
  /** Time allowed for `watch` to exit after stdin EOF before SIGTERM (then SIGKILL). Default 2 s. */
  stopTimeoutMs?: number;
  /** Sidecar stderr lines (logs) and non-fatal `error` lines (`mic-apps watch: poll_failed: …`). */
  onStderr?: (line: string) => void;
}

function commandOf(binary: SidecarBinary): { command: string; args: string[] } {
  return typeof binary === 'string'
    ? { command: binary, args: [] }
    : { command: binary.command, args: [...(binary.args ?? [])] };
}

interface Line {
  type?: unknown;
  apps?: unknown;
  code?: unknown;
  message?: unknown;
}

function parseAppsLine(msg: Line, label: string): MicAppProcess[] {
  if (!Array.isArray(msg.apps))
    throw new SidecarError(`${label}: "apps" line without an apps array`);
  try {
    return parseApps(msg.apps);
  } catch (e) {
    throw new SidecarError(`${label}: bad apps line: ${(e as Error).message}`, { cause: e });
  }
}

export class SidecarMicAppsSource implements MicAppsSource {
  readonly name: string;
  readonly #options: SidecarMicAppsSourceOptions;
  #binary: SidecarBinary | undefined;

  constructor(options: SidecarMicAppsSourceOptions = {}) {
    this.#options = options;
    this.#binary = options.binary;
    this.name = options.fixture ? 'fixture' : 'coreaudio';
  }

  list(): Promise<MicAppProcess[]> {
    const { command, args } = commandOf(this.#resolveBinary());
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args, 'mic-apps', 'list', ...this.#fixtureArgs()],
        { timeout: this.#options.timeoutMs ?? 10_000, env: this.#options.env ?? process.env },
        (error, stdout, stderr) => {
          for (const line of stderr.split('\n')) if (line) this.#options.onStderr?.(line);
          if (error)
            return reject(
              new SidecarError(
                `\`oat-audio mic-apps list\` failed: ${error.message} ${stderr}`.trim(),
              ),
            );
          try {
            const msg = JSON.parse(stdout.trim()) as Line;
            if (msg.type !== 'apps')
              throw new SidecarError(`unexpected line type ${String(msg.type)}`);
            resolve(parseAppsLine(msg, 'mic-apps list'));
          } catch (e) {
            reject(
              e instanceof SidecarError
                ? e
                : new SidecarError(
                    `mic-apps list printed ${JSON.stringify(stdout.trim().slice(0, 200))}`,
                  ),
            );
          }
        },
      );
    });
  }

  async watch(
    onApps: (apps: MicAppProcess[]) => void,
    onError: (error: Error) => void,
  ): Promise<MicAppsWatch> {
    const { command, args } = commandOf(this.#resolveBinary());
    const watchArgs = ['mic-apps', 'watch', ...this.#fixtureArgs()];
    if (this.#options.intervalMs !== undefined)
      watchArgs.push('--interval-ms', String(this.#options.intervalMs));
    const child: ChildProcessWithoutNullStreams = spawn(command, [...args, ...watchArgs], {
      env: this.#options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {}); // EPIPE if it already exited
    const stderrTail: string[] = [];
    lines(child.stderr, (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
      this.#options.onStderr?.(line);
    });

    let ready = false;
    let stopping = false;
    let failed = false;
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.on('error', (error) => resolve({ code: null, signal: null, error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    const fail = (error: Error) => {
      if (failed || stopping) return;
      failed = true;
      child.kill('SIGKILL');
      onError(error);
    };

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SidecarError('mic-apps watch: no "ready" line in time')),
        this.#options.readyTimeoutMs ?? 10_000,
      );
      lines(child.stdout, (line) => {
        let msg: Line;
        try {
          msg = JSON.parse(line) as Line;
        } catch {
          this.#options.onStderr?.(`mic-apps watch: ignoring non-JSON line ${line}`);
          return;
        }
        if (msg.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'apps' && ready && !stopping && !failed) {
          let apps: MicAppProcess[];
          try {
            apps = parseAppsLine(msg, 'mic-apps watch');
          } catch (e) {
            fail(e as Error);
            return;
          }
          onApps(apps);
        } else if (msg.type === 'error') {
          this.#options.onStderr?.(
            `mic-apps watch: ${String(msg.code)}: ${String(msg.message ?? '')}`,
          );
        }
        // Unknown types are ignored (forward compatible).
      });
      void exited.then((info) => {
        clearTimeout(timer);
        if (!ready) reject(exitError('mic-apps watch', info, stderrTail));
        else fail(exitError('mic-apps watch', info, stderrTail));
      });
    });

    try {
      await readyPromise;
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }

    let stopped: Promise<void> | undefined;
    return {
      stop: () => {
        stopped ??= (async () => {
          stopping = true;
          child.stdin.end(); // EOF = stop
          const timeout = this.#options.stopTimeoutMs ?? 2_000;
          if (await settlesWithin(exited, timeout)) return;
          child.kill('SIGTERM');
          if (await settlesWithin(exited, timeout)) return;
          child.kill('SIGKILL');
          await exited;
        })();
        return stopped;
      },
    };
  }

  #fixtureArgs(): string[] {
    return this.#options.fixture ? ['--fixture', this.#options.fixture] : [];
  }

  #resolveBinary(): SidecarBinary {
    if (this.#binary) return this.#binary;
    const found = locateSidecarBinary({ env: this.#options.env ?? process.env });
    if (!found)
      throw new SidecarError(
        'oat-audio sidecar not found (build it: pnpm --filter @oat/audio build:sidecar, or set OAT_AUDIO_BIN)',
      );
    this.#binary = found;
    return found;
  }
}

function exitError(
  label: string,
  info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
  stderrTail: string[],
): Error {
  const tail = stderrTail.length ? `: ${stderrTail.join(' | ')}` : '';
  const how = info.error
    ? info.error.message
    : info.signal
      ? `killed by ${info.signal}`
      : `exited with ${info.code}`;
  return new SidecarError(`${label} ${how}${tail}`);
}

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    partial += chunk;
    let nl: number;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl).trim();
      partial = partial.slice(nl + 1);
      if (line) onLine(line);
    }
    if (partial.length > 1024 * 1024) partial = ''; // a runaway line without newline
  });
  stream.on('end', () => {
    const line = partial.trim();
    partial = '';
    if (line) onLine(line);
  });
}

async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  const done = await Promise.race([p.then(() => true as const), timeout]);
  clearTimeout(timer);
  return done;
}
