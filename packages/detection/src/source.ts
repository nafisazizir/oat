import { MicAppProcessSchema, type MicAppProcess, type MicAppProcessInput } from './apps.ts';

/** A running mic-apps subscription. */
export interface MicAppsWatch {
  /** Stops watching; resolves once the process/subscription is gone. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Which processes are running audio input: the sidecar (`oat-audio mic-apps`, Core Audio process objects)
 * or a fixture. Reports **processes**, unfiltered — the allowlist and all rules live in `detect`.
 *
 * Contract: never prompts for any permission. `watch` calls `onApps` once with the current list, then on
 * every change (full list each time).
 */
export interface MicAppsSource {
  /** For logs: `coreaudio`, `fixture`. */
  readonly name: string;
  list(): Promise<MicAppProcess[]>;
  watch(
    onApps: (apps: MicAppProcess[]) => void,
    onError: (error: Error) => void,
  ): Promise<MicAppsWatch>;
}

/** In-memory source for tests and non-macOS runs; `setApps` simulates a change. */
export class FixtureMicAppsSource implements MicAppsSource {
  readonly name = 'fixture';
  #apps: MicAppProcess[];
  #watchers = new Set<(apps: MicAppProcess[]) => void>();

  constructor(apps: readonly MicAppProcessInput[] = []) {
    this.#apps = parseApps(apps);
  }

  setApps(apps: readonly MicAppProcessInput[]): void {
    this.#apps = parseApps(apps);
    for (const w of [...this.#watchers]) w([...this.#apps]);
  }

  get watcherCount(): number {
    return this.#watchers.size;
  }

  async list(): Promise<MicAppProcess[]> {
    return [...this.#apps];
  }

  async watch(onApps: (apps: MicAppProcess[]) => void): Promise<MicAppsWatch> {
    const watcher = (apps: MicAppProcess[]) => onApps(apps);
    this.#watchers.add(watcher);
    onApps([...this.#apps]);
    return {
      stop: async () => {
        this.#watchers.delete(watcher);
      },
    };
  }
}

export function parseApps(apps: readonly unknown[]): MicAppProcess[] {
  return apps.map((a) => MicAppProcessSchema.parse(a));
}
