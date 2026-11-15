/**
 * `OAT_DETECTION=fixture:<timeline.json>` (dev/e2e only): replays the `steps[].micApps` of a detection timeline
 * (`fixtures/detection/*.json` format, the same steps the sidecar's `mic-apps watch --fixture` replays) in
 * process, starting when the watch starts. No sidecar binary, no Core Audio: what the e2e drives detection with.
 */
import { readFileSync } from 'node:fs';

import {
  type MicAppProcess,
  type MicAppsSource,
  type MicAppsWatch,
  parseApps,
} from '@oat/detection';
import { z } from 'zod';

const ReplaySchema = z.object({
  steps: z
    .array(
      z.object({
        at: z.number().int().min(0),
        micApps: z.array(z.unknown()).optional(),
      }),
    )
    .min(1),
});

export interface ReplayStep {
  at: number;
  apps: MicAppProcess[];
}

/** The mic-apps steps of a timeline (steps without `micApps` are skipped), in order. */
export function parseReplay(json: unknown): ReplayStep[] {
  const { steps } = ReplaySchema.parse(json);
  return steps
    .filter((s) => s.micApps !== undefined)
    .map((s) => ({ at: s.at, apps: parseApps(s.micApps!) }))
    .sort((a, b) => a.at - b.at);
}

export class ReplayMicAppsSource implements MicAppsSource {
  readonly name = 'fixture';
  readonly #steps: ReplayStep[];
  #current: MicAppProcess[] = [];

  constructor(steps: ReplayStep[]) {
    this.#steps = steps;
  }

  static fromFile(file: string): ReplayMicAppsSource {
    return new ReplayMicAppsSource(parseReplay(JSON.parse(readFileSync(file, 'utf8'))));
  }

  async list(): Promise<MicAppProcess[]> {
    return [...this.#current];
  }

  async watch(onApps: (apps: MicAppProcess[]) => void): Promise<MicAppsWatch> {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let stopped = false;
    const emit = (apps: MicAppProcess[]) => {
      if (stopped) return;
      this.#current = apps;
      onApps([...apps]);
    };
    const first = this.#steps[0];
    // `watch` reports the current list right away (the source contract), then every change.
    emit(first && first.at === 0 ? first.apps : []);
    for (const step of this.#steps) {
      if (step === first && step.at === 0) continue;
      timers.push(setTimeout(() => emit(step.apps), step.at));
    }
    return {
      stop: async () => {
        stopped = true;
        for (const t of timers) clearTimeout(t);
      },
    };
  }
}
