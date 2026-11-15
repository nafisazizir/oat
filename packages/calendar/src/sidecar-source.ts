/**
 * `SidecarCalendarSource`: macOS calendars through the `oat-audio calendar …` subcommands (EventKit inside the
 * Swift sidecar; protocol in `native/oat-audio/PROTOCOL.md` → "Calendar"). Node-only (child processes);
 * import it from `@oat/calendar/node`.
 *
 * Safety: `status()` never prompts. Without `fixture`, `fetchEvents` / `watch` read the real calendar and
 * need the Calendars permission (granted by a human); without it they fail with `CalendarAccessError` rather
 * than prompting. `requestAccess` (the only prompting call) is deliberately not part of this class.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { locateSidecarBinary, SidecarError, type SidecarBinary } from '@oat/audio/node';
import { CalendarAccessSchema, type CalendarAccess, type CalendarEvent } from '@oat/core';

import { parseEventLines } from './fixture-source.ts';
import {
  CalendarAccessError,
  type CalendarRange,
  type CalendarSource,
  type CalendarWatch,
} from './types.ts';

/** `oat-audio` exit code for "no Calendars access" (EX_NOPERM). */
export const EXIT_NO_ACCESS = 77;

export interface SidecarCalendarSourceOptions {
  /** Default: `locateSidecarBinary()` (`OAT_AUDIO_BIN`, packaged resources, dev build). */
  binary?: SidecarBinary;
  /** Serve this JSON fixture instead of EventKit (`--fixture`): no permission needed. */
  fixture?: string;
  env?: NodeJS.ProcessEnv;
  /** Timeout for `status` / `events`. Default 15 s. */
  timeoutMs?: number;
  /** `watch --debounce-ms`. Default: the sidecar's (500 ms). */
  debounceMs?: number;
  /** Time allowed for `watch` to print `ready`. Default 10 s. */
  readyTimeoutMs?: number;
  /** Time allowed for `watch` to exit after stdin EOF before SIGTERM (then SIGKILL). Default 2 s. */
  stopTimeoutMs?: number;
  /** Sidecar stderr lines (logs). */
  onStderr?: (line: string) => void;
}

const MAX_OUTPUT = 64 * 1024 * 1024;

function commandOf(binary: SidecarBinary): { command: string; args: string[] } {
  return typeof binary === 'string'
    ? { command: binary, args: [] }
    : { command: binary.command, args: [...(binary.args ?? [])] };
}

export class SidecarCalendarSource implements CalendarSource {
  readonly name: string;
  readonly #options: SidecarCalendarSourceOptions;
  #binary: SidecarBinary | undefined;

  constructor(options: SidecarCalendarSourceOptions = {}) {
    this.#options = options;
    this.#binary = options.binary;
    this.name = options.fixture ? 'fixture' : 'eventkit';
  }

  async status(): Promise<CalendarAccess> {
    const { stdout } = await this.#run(['calendar', 'status', ...this.#fixtureArgs()]);
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new SidecarError(`calendar status printed ${JSON.stringify(stdout.slice(0, 200))}`);
    }
    const parsed = CalendarAccessSchema.safeParse(json);
    if (!parsed.success)
      throw new SidecarError(`calendar status: unexpected output: ${parsed.error.message}`);
    return parsed.data;
  }

  async fetchEvents(range: CalendarRange): Promise<CalendarEvent[]> {
    if (!(range.from.getTime() < range.to.getTime()))
      throw new RangeError('range.from must be before range.to');
    const { stdout } = await this.#run([
      'calendar',
      'events',
      '--from',
      range.from.toISOString(),
      '--to',
      range.to.toISOString(),
      ...this.#fixtureArgs(),
    ]);
    try {
      return parseEventLines(stdout);
    } catch (e) {
      throw new SidecarError(`calendar events: ${(e as Error).message}`, { cause: e });
    }
  }

  async watch(onChange: () => void, onError: (error: Error) => void): Promise<CalendarWatch> {
    const { command, args } = commandOf(this.#resolveBinary());
    const watchArgs = ['calendar', 'watch', ...this.#fixtureArgs()];
    if (this.#options.debounceMs !== undefined)
      watchArgs.push('--debounce-ms', String(this.#options.debounceMs));
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
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.on('error', (error) => resolve({ code: null, signal: null, error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SidecarError('calendar watch: no "ready" line in time'));
      }, this.#options.readyTimeoutMs ?? 10_000);
      lines(child.stdout, (line) => {
        let msg: { type?: unknown };
        try {
          msg = JSON.parse(line) as { type?: unknown };
        } catch {
          this.#options.onStderr?.(`calendar watch: ignoring non-JSON line ${line}`);
          return;
        }
        if (msg.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'changed' && ready && !stopping) {
          onChange();
        }
        // Unknown types are ignored (forward compatible).
      });
      void exited.then((info) => {
        clearTimeout(timer);
        if (!ready) reject(exitError('calendar watch', info, stderrTail));
        else if (!stopping) onError(exitError('calendar watch', info, stderrTail));
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

  // --- internals -----------------------------------------------------------------------------------------

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

  #run(subArgs: string[]): Promise<{ stdout: string }> {
    const { command, args } = commandOf(this.#resolveBinary());
    const label = subArgs.slice(0, 2).join(' ');
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args, ...subArgs],
        {
          timeout: this.#options.timeoutMs ?? 15_000,
          env: this.#options.env ?? process.env,
          maxBuffer: MAX_OUTPUT,
        },
        (error, stdout, stderr) => {
          for (const line of stderr.split('\n')) if (line) this.#options.onStderr?.(line);
          if (!error) return resolve({ stdout });
          const code = (error as { code?: unknown }).code;
          if (code === EXIT_NO_ACCESS)
            return reject(
              new CalendarAccessError(`${label}: ${stderr.trim() || 'no calendar access'}`),
            );
          reject(
            new SidecarError(`\`oat-audio ${label}\` failed: ${error.message} ${stderr}`.trim()),
          );
        },
      );
    });
  }
}

function exitError(
  label: string,
  info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
  stderrTail: string[],
): Error {
  const tail = stderrTail.length ? `: ${stderrTail.join(' | ')}` : '';
  if (info.code === EXIT_NO_ACCESS)
    return new CalendarAccessError(`${label}: no calendar access${tail}`);
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
